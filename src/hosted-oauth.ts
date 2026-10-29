import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  InvalidRequestError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { HostedStore, opaque, fingerprint } from "./hosted-store.js";
import { PluginError } from "./errors.js";
import { DNS_SCOPE, MAIL_SCOPE, DEPLOY_SCOPE, type ResourceConsent } from "./hosted-resources.js";

export const SCOPE = "infomaniak:read";
export const WRITE_SCOPE = "infomaniak:write:disposable-dns";
const DAY = 86_400_000;
export interface Grant {
  activated: boolean;
  scopes?: string[];
  writeZone?: string;
  resources?: ResourceConsent;
  client: string;
  owner: string;
  account: number;
  token: string;
  created: number;
  expires: number;
}
interface Credential {
  client: string;
  grant: string;
  expires?: number;
}
interface Code extends Credential {
  challenge: string;
  redirect: string;
}
export interface Pending {
  scopes?: string[];
  client: string;
  redirect: string;
  state?: string;
  challenge: string;
  csrf: string;
  browser: string;
  expires: number;
  token?: string;
  accounts?: { id: number; name: string }[];
}
export interface Browser {
  csrf: string;
}

/** SDK handlers implement the protocol; this provider binds consent, audience and encrypted state. */
export class HostedOAuth implements OAuthServerProvider {
  readonly resource: URL;
  readonly clientsStore: OAuthRegisteredClientsStore;
  constructor(
    readonly store: HostedStore,
    readonly origin: URL,
    readonly writesEnabled = false,
    readonly resourceWrites = false,
  ) {
    const boundOrigin = store.get<string>("meta", "hosted-origin");
    if (boundOrigin && boundOrigin !== origin.href)
      throw new PluginError(
        "hosted_origin_changed",
        "This hosted state belongs to a different origin. Restore its original origin or create a new isolated installation and reconnect users.",
      );
    if (!boundOrigin) store.put("meta", "hosted-origin", origin.href, Number.MAX_SAFE_INTEGER);
    this.resource = new URL("/mcp", origin);
    const retainClient = (
      client: OAuthClientInformationFull,
    ): OAuthClientInformationFull | undefined => {
      const initial =
        (client.client_id_issued_at ?? Math.floor(store.now() / 1000)) * 1000 + 86_400_000;
      const expires = Math.max(
        initial,
        ...store
          .list<Grant>("grant")
          .filter((r) => r.value.client === client.client_id)
          .map((r) => r.value.expires),
      );
      if (expires <= store.now()) {
        store.delete("client", client.client_id);
        return undefined;
      }
      store.put("client", client.client_id, client, expires);
      return client;
    };
    // Migrate older permanent registrations without expiring a live grant's client.
    for (const { value } of store.list<OAuthClientInformationFull>("client")) retainClient(value);
    this.clientsStore = {
      getClient: (id) => {
        const client = store.get<OAuthClientInformationFull>("client", id);
        return client ? retainClient(client) : undefined;
      },
      registerClient: (input) => {
        store.prune();
        if (
          store.list("client").length >= 2000 ||
          input.redirect_uris.length > 5 ||
          !input.redirect_uris.length
        )
          throw new InvalidClientMetadataError("Client registration is currently full or invalid.");
        if (
          (input.client_name?.length ?? 0) > 100 ||
          (input.token_endpoint_auth_method !== "none" &&
            input.token_endpoint_auth_method !== "client_secret_post" &&
            input.token_endpoint_auth_method !== undefined)
        )
          throw new InvalidClientMetadataError("Unsupported client settings.");
        const redirect_uris = input.redirect_uris.filter((uri) => {
          try {
            const u = new URL(uri);
            return (
              uri.length <= 2048 &&
              !u.username &&
              !u.password &&
              !u.hash &&
              (u.protocol === "https:" ||
                (u.protocol === "http:" &&
                  ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
            );
          } catch {
            return false;
          }
        });
        if (!redirect_uris.length)
          throw new InvalidClientMetadataError("Use HTTPS callbacks or an HTTP loopback callback.");
        if (
          input.scope &&
          input.scope.split(" ").some((scope) => !this.supportedScopes.includes(scope))
        )
          throw new InvalidClientMetadataError("Requested scope is unavailable.");
        const client = {
          ...input,
          redirect_uris,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(store.now() / 1000),
          scope: input.scope ?? this.defaultScopes.join(" "),
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        };
        store.put("client", client.client_id, client, store.now() + 86_400_000);
        return client;
      },
    };
  }
  private target(resource?: URL): void {
    if (resource && resource.href !== this.resource.href)
      throw new InvalidTargetError("This authorization is only for the Infomaniak MCP endpoint.");
  }
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.target(params.resource);
    // An explicit client/request scope remains authoritative. Otherwise offer
    // the supported read + write flow; the browser still decides the grant.
    const scopes = params.scopes?.length
      ? params.scopes
      : client.scope?.trim()
        ? client.scope
            .trim()
            .split(/\s+/)
            .filter((scope) => this.supportedScopes.includes(scope))
        : this.defaultScopes;
    if (scopes.some((scope) => !this.supportedScopes.includes(scope)))
      throw new InvalidScopeError("Requested scope is unavailable.");
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || (params.state?.length ?? 0) > 1024)
      throw new InvalidRequestError("Invalid PKCE challenge or state.");
    this.store.prune();
    if (this.store.list("pending").length >= 1000)
      throw new InvalidRequestError("Please try connecting later.");
    if (
      scopes.some((s) => [WRITE_SCOPE, DNS_SCOPE, MAIL_SCOPE, DEPLOY_SCOPE].includes(s)) &&
      !scopes.includes(SCOPE)
    )
      throw new InvalidScopeError("Disposable DNS access requires the read scope too.");
    // Concurrent client sign-ins keep their own CSRF and transaction values
    // while sharing a browser binding, so a second tab cannot invalidate one.
    const candidates = (res.req?.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([name]) => name === this.cookieName);
    const existing = candidates.length === 1 ? candidates[0]?.[1] : undefined;
    const transaction = opaque(),
      browser = existing && /^[A-Za-z0-9_-]{43}$/.test(existing) ? existing : opaque(),
      csrf = opaque();
    const pending: Pending = {
      scopes: [...new Set(scopes)],
      client: client.client_id,
      redirect: params.redirectUri,
      challenge: params.codeChallenge,
      csrf,
      browser: fingerprint(browser),
      expires: this.store.now() + 10 * 60_000,
      ...(params.state !== undefined ? { state: params.state } : {}),
    };
    this.store.put("pending", fingerprint(transaction), pending, this.store.now() + 10 * 60_000);
    res.cookie(this.cookieName, browser, {
      httpOnly: true,
      secure: this.origin.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: 10 * 60_000,
    });
    res.redirect(303, "/connect?request=" + transaction);
  }
  get supportedScopes(): string[] {
    return this.writesEnabled
      ? [SCOPE, WRITE_SCOPE, ...(this.resourceWrites ? [DNS_SCOPE, MAIL_SCOPE, DEPLOY_SCOPE] : [])]
      : [SCOPE];
  }
  get defaultScopes(): string[] {
    return this.writesEnabled && this.resourceWrites
      ? [SCOPE, DNS_SCOPE, MAIL_SCOPE, DEPLOY_SCOPE]
      : this.supportedScopes;
  }
  get cookieName(): string {
    return this.origin.protocol === "https:" ? "__Host-ik_connect" : "ik_connect";
  }
  get manageCookie(): string {
    return this.origin.protocol === "https:" ? "__Host-ik_manage" : "ik_manage";
  }
  complete(
    id: string,
    pending: Pending,
    account: number,
    owner: string,
    writeZone?: string,
    resources?: ResourceConsent,
  ): string {
    if (writeZone && (!this.writesEnabled || !pending.scopes?.includes(WRITE_SCOPE)))
      throw new InvalidScopeError("A new write consent is required.");
    const scopes = [SCOPE, ...(writeZone ? [WRITE_SCOPE] : [])];
    for (const [scope, selected] of [
      [DNS_SCOPE, resources?.zones.length],
      [MAIL_SCOPE, resources?.mailboxes.length],
      [DEPLOY_SCOPE, resources?.deploymentEnrollment || resources?.deployments?.length],
    ] as const) {
      if (!selected) continue;
      if (!this.writesEnabled || !this.resourceWrites || !pending.scopes?.includes(scope))
        throw new InvalidScopeError("A fresh resource consent is required.");
      scopes.push(scope);
    }
    return this.store.atomic(() => {
      if (
        !pending.token ||
        !pending.accounts?.some((a) => a.id === account) ||
        !this.store.take<Pending>("pending", fingerprint(id))
      )
        throw new InvalidGrantError("Connect again to choose an accessible account.");
      const grant = randomUUID(),
        now = this.store.now(),
        code = opaque();
      this.store.put(
        "connection-record",
        grant,
        { owner, account, client: pending.client, created: now },
        now + 60_000,
      );
      this.store.put(
        "grant",
        grant,
        {
          activated: false,
          scopes,
          ...(writeZone ? { writeZone } : {}),
          ...(resources ? { resources } : {}),
          client: pending.client,
          owner,
          account,
          token: pending.token,
          created: now,
          expires: now + 30 * DAY,
        } satisfies Grant,
        now + 60_000,
      );
      this.store.put(
        "code",
        fingerprint(code),
        {
          client: pending.client,
          grant,
          challenge: pending.challenge,
          redirect: pending.redirect,
        } satisfies Code,
        now + 60_000,
      );
      const redirect = new URL(pending.redirect);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("iss", this.origin.href);
      if (pending.state !== undefined) redirect.searchParams.set("state", pending.state);
      return redirect.href;
    });
  }
  private code(client: OAuthClientInformationFull, value: string): Code {
    const code = this.store.get<Code>("code", fingerprint(value));
    if (!code || code.client !== client.client_id)
      throw new InvalidGrantError("Authorization code expired or already used.");
    return code;
  }
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    value: string,
  ): Promise<string> {
    return this.code(client, value).challenge;
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    value: string,
    _verifier?: string,
    redirect?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.target(resource);
    const code = this.code(client, value);
    if (redirect !== code.redirect)
      throw new InvalidGrantError("The callback must match the authorization request.");
    return this.store.atomic(() => {
      if (!this.store.take("code", fingerprint(value)))
        throw new InvalidGrantError("Authorization code already used.");
      return this.issue(code);
    });
  }
  private issue(ref: Credential): OAuthTokens {
    const grant = this.store.get<Grant>("grant", ref.grant);
    if (!grant || grant.client !== ref.client)
      throw new InvalidGrantError("Connection expired or disconnected.");
    if (!grant.activated) {
      grant.activated = true;
      this.store.put("grant", ref.grant, grant, grant.expires);
      const record = this.store.get("connection-record", ref.grant);
      if (record) this.store.put("connection-record", ref.grant, record, grant.created + 37 * DAY);
    }
    const access = opaque(),
      refresh = opaque();
    const now = this.store.now(),
      expiry = Math.min(now + 15 * 60_000, grant.expires);
    this.store.put(
      "access",
      fingerprint(access),
      { client: ref.client, grant: ref.grant, expires: Math.floor(expiry / 1000) },
      expiry,
    );
    this.store.put("refresh", fingerprint(refresh), ref, grant.expires);
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor((expiry - now) / 1000),
      refresh_token: refresh,
      scope: (grant.scopes ?? [SCOPE]).join(" "),
    };
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    value: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.target(resource);
    const key = fingerprint(value),
      ref = this.store.get<Credential>("refresh", key),
      spent = this.store.get<Credential>("spent", key);
    if (spent?.client === client.client_id) {
      this.disconnect(spent.grant);
      throw new InvalidGrantError("Refresh token reuse disconnected this connection.");
    }
    return this.store.atomic(() => {
      if (!ref || ref.client !== client.client_id || !this.store.take("refresh", key))
        throw new InvalidGrantError("Refresh token expired or already used.");
      const grant = this.store.get<Grant>("grant", ref.grant);
      if (!grant) throw new InvalidGrantError("Connection expired or disconnected.");
      if (scopes?.some((scope) => !(grant.scopes ?? [SCOPE]).includes(scope)))
        throw new InvalidScopeError("Scope expansion is not allowed.");
      if (scopes?.length) {
        if (!scopes.includes(SCOPE)) throw new InvalidScopeError("Read scope is required.");
        grant.scopes = [...new Set(scopes)];
        if (!scopes.includes(WRITE_SCOPE)) delete grant.writeZone;
        if (grant.resources) {
          if (!scopes.includes(DNS_SCOPE)) grant.resources.zones = [];
          if (!scopes.includes(MAIL_SCOPE)) grant.resources.mailboxes = [];
          if (!scopes.includes(DEPLOY_SCOPE)) {
            delete grant.resources.deployments;
            delete grant.resources.deploymentEnrollment;
          }
        }
        this.store.put("grant", ref.grant, grant, grant.expires);
      }
      this.store.put("spent", key, ref, grant.expires);
      return this.issue(ref);
    });
  }
  async verifyAccessToken(value: string): Promise<AuthInfo> {
    const ref = this.store.get<Credential>("access", fingerprint(value));
    const grant = ref && this.store.get<Grant>("grant", ref.grant);
    if (!ref || !grant || grant.client !== ref.client)
      throw new InvalidTokenError("Connection expired or disconnected.");
    return {
      token: value,
      clientId: ref.client,
      scopes: grant.scopes ?? [SCOPE],
      expiresAt: ref.expires ?? 0,
      resource: this.resource,
      extra: { grant: ref.grant },
    };
  }
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const key = fingerprint(request.token);
    for (const kind of ["access", "refresh", "spent"]) {
      const ref = this.store.get<Credential>(kind, key);
      if (ref?.client === client.client_id) this.disconnect(ref.grant);
    }
  }
  disconnect(id: string): void {
    const grant = this.store.get<Grant>("grant", id);
    if (grant)
      this.store.put(
        "connection-record",
        id,
        {
          owner: grant.owner,
          account: grant.account,
          client: grant.client,
          created: grant.created,
          disconnected: this.store.now(),
        },
        this.store.now() + 7 * DAY,
      );
    this.store.delete("grant", id);
    this.store.prune();
  }
}
