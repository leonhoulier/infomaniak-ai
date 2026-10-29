import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import { HostedMcp } from "./hosted-mcp.js";
import { NativeApproval } from "./native-approval.js";
import { writeTarget } from "./write-preview.js";
import { isAbsolute } from "node:path";
import {
  mcpAuthRouter,
  createOAuthMetadata,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { HostedStore, opaque, fingerprint, readHostedKey } from "./hosted-store.js";
import {
  HostedOAuth,
  SCOPE,
  WRITE_SCOPE,
  type Pending,
  type Browser,
  type Grant,
} from "./hosted-oauth.js";
import { ApiError, PublicApi, RequestQueue, list, object, type Api } from "./provider.js";
import { createReadOnlyFetch } from "./policy.js";
import { Discovery } from "./discovery.js";
import { createProtocol } from "./protocol.js";
import { PluginError, boundedResult, redact } from "./errors.js";
import {
  page as documentPage,
  home,
  clientGuide,
  escapeHtml as e,
  COPY_SCRIPT,
} from "./hosted-pages.js";
import { mountClients } from "./hosted-clients.js";
import { PUBLIC_PATHS, publicPage, capabilities, agentReference } from "./hosted-public.js";
import { HostedWrites, verifyWriteZone, TEST_NAME } from "./hosted-writes.js";
import { handleWriteApi } from "./write-api.js";
import { HostedDeployments } from "./hosted-deployments.js";
import { mountDownloads } from "./hosted-downloads.js";
import { mountOperations } from "./hosted-operations.js";
import type { Plan } from "./journal.js";
import {
  DNS_SCOPE,
  MAIL_SCOPE,
  DEPLOY_SCOPE,
  verifyResources,
  resourceWords,
  type ResourceConsent,
} from "./hosted-resources.js";
import { createHostedAnalytics, type HostedAnalytics } from "./hosted-analytics.js";

export interface HostedOptions {
  origin: URL;
  store: HostedStore;
  api?: (token: string) => Api;
  allowLoopback?: boolean;
  previewMode?: "demo" | "live";
  analytics?: HostedAnalytics | undefined;
  disposableDnsWrites?: boolean;
  resourceWrites?: boolean;
  trustProxyHops?: 0 | 1;
}
export const PREVIEW_DEMO_TOKEN = "demo-infomaniak-token-for-local-preview";
export function validateHostedOrigin(origin: URL, allowLoopback = false): void {
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    !(
      origin.protocol === "https:" ||
      (allowLoopback &&
        origin.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(origin.hostname))
    )
  )
    throw new PluginError(
      "invalid_configuration",
      "Hosted access requires an HTTPS origin without a path. HTTP is only permitted for explicit loopback testing.",
    );
}
function cookie(req: Request, name: string): string {
  const matches = (req.headers.cookie ?? "")
    .split(";")
    .map((p) => p.trim().split("="))
    .filter(([key]) => key === name);
  return matches.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(matches[0]![1] ?? "")
    ? matches[0]![1]!
    : "";
}
function param(req: Request, name: string): string {
  const value: unknown = req.body?.[name];
  return typeof value === "string" ? value : "";
}

/** Bound validation fan-out before SDK schemas can allocate per-element issues. */
function inputWithinBudget(value: unknown): boolean {
  const pending = [{ value, depth: 0 }];
  for (let index = 0; index < pending.length; index++) {
    if (pending.length > 512) return false;
    const item = pending[index]!;
    if (item.depth > 16) return false;
    if (item.value && typeof item.value === "object") {
      const entries = Object.values(item.value);
      if (entries.length > (Array.isArray(item.value) ? 64 : 128)) return false;
      for (const entry of entries) pending.push({ value: entry, depth: item.depth + 1 });
    }
  }
  return true;
}

export function createHosted(options: HostedOptions): { server: Server; oauth: HostedOAuth } {
  validateHostedOrigin(options.origin, options.allowLoopback);
  if (options.previewMode && (options.origin.protocol !== "http:" || !options.allowLoopback))
    throw new PluginError(
      "invalid_configuration",
      "Preview mode is only available on loopback HTTP.",
    );
  if (options.previewMode === "demo" && !options.api)
    throw new PluginError(
      "invalid_configuration",
      "Demo previews require a fixture API transport.",
    );
  const previewNotice =
    options.previewMode === "demo"
      ? `Private demo · Example data only. Use ${PREVIEW_DEMO_TOKEN} in the token field. Real tokens are refused.`
      : options.previewMode === "live"
        ? "Private account test · Your token is used for read-only requests to Infomaniak. Temporary connections are removed when this test stops."
        : undefined;
  const page = (title: string, body: string) => documentPage(title, body, previewNotice);
  const { store, origin } = options,
    oauth = new HostedOAuth(store, origin, options.disposableDnsWrites, options.resourceWrites),
    app = express(),
    queue = new RequestQueue();
  const api =
    options.api ?? ((token: string) => new PublicApi(token, queue, createReadOnlyFetch(fetch)));
  const writes = options.disposableDnsWrites
    ? new HostedWrites(store, (token, guard) =>
        options.api
          ? {
              request: (method, path, body, signal) => {
                try {
                  guard();
                } catch {
                  throw new ApiError(false);
                }
                return options.api!(token).request(method, path, body, signal);
              },
            }
          : new PublicApi(token, queue, fetch, guard),
      )
    : undefined;
  const deployments =
    writes && options.resourceWrites ? new HostedDeployments(store, writes.journal) : undefined;
  const nativeApproval = writes ? new NativeApproval(writes.journal) : undefined;
  const canWrite = (grant: Grant) =>
    Boolean(writes?.hasAccess(grant) || deployments?.hasAccess(grant));
  const isDeployment = (id: string, args: unknown) => {
    const input = object(args);
    if (typeof input.operation === "string") return input.operation.startsWith("deployment.");
    if (typeof input.plan_id === "string" && writes)
      return writes.journal.get(input.plan_id, id).operation.startsWith("deployment.");
    return false;
  };
  const active = new Map<string, number>(),
    attempts = new Map<string, { count: number; until: number }>();
  const atCapacity = (id: string) =>
    (active.get(id) ?? 0) >= 4 || [...active.values()].reduce((a, b) => a + b, 0) >= 32;
  function reserveWork(id: string): () => void {
    if (atCapacity(id))
      throw new PluginError("rate_limited", "Please try again after the running tools finish.");
    active.set(id, (active.get(id) ?? 0) + 1);
    return () => {
      const n = (active.get(id) ?? 1) - 1;
      if (n) active.set(id, n);
      else active.delete(id);
    };
  }
  app.disable("x-powered-by");
  // Set only for a deployment whose sole ingress proxy overwrites forwarding headers.
  app.set("trust proxy", options.trustProxyHops ?? 0);
  app.use((req, res, next) => {
    res.set({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      // no-referrer turns native form POST Origins into null. Private pages
      // retain same-origin CSRF checks without leaking referrers externally.
      "referrer-policy": (PUBLIC_PATHS as readonly string[]).includes(req.path)
        ? "no-referrer"
        : "same-origin",
      "x-robots-tag": (PUBLIC_PATHS as readonly string[]).includes(req.path)
        ? "index, follow"
        : "noindex, nofollow",
      "content-security-policy": `default-src 'none'; script-src 'sha256-${createHash("sha256").update(COPY_SCRIPT).digest("base64")}'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
    });
    if (origin.protocol === "https:") res.set("strict-transport-security", "max-age=31536000");
    if (req.path === "/mcp" && req.originalUrl.includes("?")) {
      res.status(400).send("MCP URLs do not accept query parameters.");
      return;
    }
    if (req.headers.host !== origin.host || req.originalUrl.length > 8192) {
      res.status(403).send("Unexpected host or request.");
      return;
    }
    if (
      (req.headers["content-length"] && Number(req.headers["content-length"]) > 16_384) ||
      req.headers["content-encoding"]
    ) {
      res.status(413).send("Request is too large or compressed.");
      return;
    }
    next();
  });
  // Bound SDK bodies too; OAuth forms and MCP JSON are limited before their handlers.
  app.use(
    express.urlencoded({ extended: false, limit: "12kb", parameterLimit: 100, inflate: false }),
  );
  app.use(express.json({ limit: "16kb", inflate: false }));
  app.use((req, res, next) => {
    if (!inputWithinBudget(req.body)) {
      res.status(400).type("text").send("Request structure exceeds its budget.");
      return;
    }
    next();
  });
  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      mode: writes
        ? options.resourceWrites
          ? "hosted-resources"
          : "hosted-scoped-dns-beta"
        : "hosted-discovery",
    });
  });
  const count = (
    req: Pick<Request, "headers">,
    event: Parameters<HostedAnalytics["record"]>[0],
    tool?: string,
  ) => {
    if (req.headers["sec-gpc"] !== "1" && req.headers.dnt !== "1")
      options.analytics?.record(event, tool);
  };
  app.get("/", (req, res) => {
    count(req, "homepage_viewed");
    res
      .type("html")
      .send(
        home(oauth.resource.href, previewNotice, Boolean(writes), Boolean(options.resourceWrites)),
      );
  });
  mountClients(app, origin, previewNotice);
  app.get("/clients/:client", (req, res, next) => {
    const html = clientGuide(
      String(req.params.client),
      oauth.resource.href,
      previewNotice,
      Boolean(options.resourceWrites),
    );
    if (!html) {
      next();
      return;
    }
    res.type("html").send(html);
  });
  for (const path of ["/api", "/privacy", "/cookies", "/support", "/terms"])
    app.get(path, (_req, res) => {
      res
        .type("html")
        .send(
          publicPage(
            path,
            origin,
            Boolean(options.analytics),
            previewNotice,
            Boolean(writes),
            Boolean(options.resourceWrites),
          ),
        );
    });
  app.get("/api/capabilities", (_req, res) => {
    res
      .set("access-control-allow-origin", "*")
      .json(capabilities(origin, Boolean(writes), Boolean(options.resourceWrites)));
  });
  app.get("/llms.txt", (_req, res) => {
    res
      .type("text/plain")
      .send(agentReference(origin, Boolean(writes), Boolean(options.resourceWrites)));
  });
  app.get("/robots.txt", (_req, res) => {
    res
      .type("text/plain")
      .send(
        `User-agent: *\nAllow: /\nDisallow: /connect\nDisallow: /connections\nDisallow: /authorize\nDisallow: /register\nDisallow: /token\nDisallow: /revoke\nDisallow: /mcp\nDisallow: /write-reviews\nDisallow: /operations\nDisallow: /runners\nDisallow: /runner-api\nDisallow: /api/v1\nSitemap: ${new URL("/sitemap.xml", origin).href}\n`,
      );
  });
  app.get("/sitemap.xml", (_req, res) => {
    res
      .type("application/xml")
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${PUBLIC_PATHS.map((path) => `<url><loc>${e(new URL(path, origin).href)}</loc></url>`).join("")}</urlset>`,
      );
  });
  const fontFiles = new Set([
    "IBMPlexSans-Regular.woff2",
    "IBMPlexSans-Medium.woff2",
    "IBMPlexSans-SemiBold.woff2",
  ]);
  app.get("/fonts/:font", async (req, res, next) => {
    const name = String(req.params.font);
    if (!fontFiles.has(name)) {
      next();
      return;
    }
    res
      .set("cache-control", "public, max-age=86400")
      .type("font/woff2")
      .send(await readFile(new URL("../data/fonts/" + name, import.meta.url)));
  });
  app.get("/social.png", async (_req, res) => {
    res.type("image/png").send(await readFile(new URL("../data/social.png", import.meta.url)));
  });
  app.get("/favicon.svg", (_req, res) => {
    res
      .type("image/svg+xml")
      .send(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#0068b5"/><path d="M19 44a10 10 0 0 1-1-20 13 13 0 0 1 25-1 10 10 0 0 1 2 21Z" fill="none" stroke="white" stroke-width="4"/></svg>',
      );
  });
  const authOptions = {
    provider: oauth,
    issuerUrl: origin,
    resourceServerUrl: oauth.resource,
    resourceName: "Infomaniak AI",
    scopesSupported: oauth.supportedScopes,
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    serviceDocumentationUrl: new URL("/", origin),
  };
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.set("access-control-allow-origin", "*").json({
      ...createOAuthMetadata(authOptions),
      authorization_response_iss_parameter_supported: true,
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    });
  });
  app.use(mcpAuthRouter(authOptions));

  function pending(req: Request, id: string): Pending {
    const p = store.get<Pending>("pending", fingerprint(id));
    if (!p || p.browser !== fingerprint(cookie(req, oauth.cookieName)))
      throw new PluginError(
        "connection_expired",
        "This connection page expired. Start again from your AI app.",
      );
    return p;
  }
  function csrf(req: Request, value: string): void {
    if (
      req.headers.origin !== origin.origin ||
      param(req, "csrf") !== value ||
      !req.is("application/x-www-form-urlencoded")
    )
      throw new PluginError("invalid_consent", "Open the connection page and try again.");
  }
  function connectPage(id: string, p: Pending, message = ""): string {
    const client = store.get<{ client_name?: string }>("client", p.client);
    const label = client?.client_name ?? "Your AI app",
      host = new URL(p.redirect).host;
    const fields = `<input type="hidden" name="request" value="${e(id)}"><input type="hidden" name="csrf" value="${e(p.csrf)}">`;
    return page(
      "Connect your Infomaniak account",
      `<h1>Your services.<br>In ${e(label)}.</h1><p class="lead">${writes && p.scopes?.some((s) => [WRITE_SCOPE, DNS_SCOPE, MAIL_SCOPE, DEPLOY_SCOPE].includes(s)) ? "Connect your account and choose the resources your AI can manage." : "Authorise account and product discovery."} Your token stays out of the conversation.</p><section class="panel"><small>Requested by ${e(label)} · return address <strong>${e(host)}</strong>. This name is supplied by the app; check that you recognize the destination.</small>${message ? `<p class="error" role="alert">${e(message)}</p>` : ""}${p.accounts ? `<form method="post" action="/connect/finish">${fields}<label for="account">Which account would you like to share?</label><select id="account" name="account" required><option value="">Choose an account</option>${p.accounts.map((a) => `<option value="${a.id}">${e(a.name)} · ${a.id}</option>`).join("")}</select><p class="notice">This connection can list this account and its products. It cannot read email messages. ${writes && p.scopes?.some((s) => [WRITE_SCOPE, DNS_SCOPE, MAIL_SCOPE, DEPLOY_SCOPE].includes(s)) ? "Choose managed resources or read-only access below. Each change needs its own review." : "This connection is read-only."} Your Infomaniak token is encrypted on this service and is never sent to ${e(label)}.</p>${writes && options.resourceWrites && (p.scopes?.includes(DNS_SCOPE) || p.scopes?.includes(MAIL_SCOPE) || p.scopes?.includes(DEPLOY_SCOPE)) ? `<fieldset class="write-consent"><legend>Resources your AI can manage</legend><label><input type="checkbox" name="enable_resources" value="yes" checked>Allow changes to the resources below</label>${p.scopes?.includes(DNS_SCOPE) ? '<label for="dns-zones">Domains for DNS management</label><input id="dns-zones" name="dns_zones" placeholder="example.com, another.example" maxlength="5200" autocomplete="off"><small>Create, edit and delete records in these domains. One domain per line or separated by commas.</small>' : ""}${p.scopes?.includes(MAIL_SCOPE) ? '<label for="mailboxes">Existing mailbox addresses</label><input id="mailboxes" name="mailbox_addresses" placeholder="support@example.com" maxlength="5200" autocomplete="off"><small>Manage aliases and forwarding for these mailboxes. This does not grant message access.</small>' : ""}${p.scopes?.includes(DEPLOY_SCOPE) ? '<label><input type="checkbox" name="deployment_enrollment" value="yes" checked>Allow deployment on runners I pair and approve in this browser</label><small>No server access exists until you pair your own runner and review its app permissions.</small>' : ""}<small>Only resources verified in the selected account are granted. Every change needs review. Uncheck to connect read-only.</small></fieldset>` : ""}${writes && p.scopes?.includes(WRITE_SCOPE) && !(options.resourceWrites && p.scopes?.some((s) => [DNS_SCOPE, MAIL_SCOPE, DEPLOY_SCOPE].includes(s))) ? `<fieldset class="write-consent"><legend>DNS write access</legend><label><input type="checkbox" name="enable_dns_test" value="yes" checked>Enable DNS writes (recommended)</label><label for="test-zone">Domain in the account above</label><input id="test-zone" name="test_zone" type="text" placeholder="example.com" maxlength="253" autocomplete="off"><small>Current beta: TXT records at ${TEST_NAME} in the domain above. Every change requires a separate review in this browser. Uncheck Enable DNS writes for read-only access; no domain is then needed.</small></fieldset>` : ""}<button name="decision" value="allow">Allow selected access</button><button class="secondary" name="decision" value="cancel" formnovalidate>Cancel</button></form>` : `<form method="post" action="/connect/token">${fields}<label for="provider-token">Infomaniak API token</label><input id="provider-token" name="provider_token" type="password" required minlength="20" maxlength="8192" autocomplete="off" spellcheck="false" autocapitalize="none"><p><a href="https://www.infomaniak.com/en/support/faq/2582/add-and-manage-infomaniak-api-tokens" target="_blank" rel="noreferrer noopener">Create an API token in Infomaniak</a></p><small>Use the accounts scope and only the product permissions you need. This service stores the token encrypted; its operator can decrypt it for API requests.</small><button>Find my accounts</button></form>`}</section>`,
    );
  }
  // Chromium checks form-action across redirects. Permit only the registered
  // callback origin on the account-consent page, so the OAuth return can finish.
  function consentPolicy(res: Response, p: Pending): void {
    if (p.accounts)
      res.set(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self' " +
          new URL(p.redirect).origin +
          "; frame-ancestors 'none'; base-uri 'none'",
      );
  }
  app.get("/connect", (req, res) => {
    const id = typeof req.query.request === "string" ? req.query.request : "";
    const p = pending(req, id);
    consentPolicy(res, p);
    res.type("html").send(connectPage(id, p));
  });
  app.post("/connect/token", async (req, res) => {
    const id = param(req, "request"),
      p = pending(req, id);
    csrf(req, p.csrf);
    if (p.accounts)
      throw new PluginError(
        "already_verified",
        "Choose an account on the verified connection page, or start again from your AI app.",
      );
    const now = store.now();
    for (const [ip, value] of attempts) if (value.until <= now) attempts.delete(ip);
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown",
      limit = attempts.get(ip) ?? { count: 0, until: now + 60_000 };
    if (attempts.size >= 1000 || limit.count >= 10) {
      res.status(429).send("Please wait a minute before trying again.");
      return;
    }
    limit.count++;
    attempts.set(ip, limit);
    const token = param(req, "provider_token").trim();
    try {
      if (options.previewMode === "demo" && token !== PREVIEW_DEMO_TOKEN)
        throw new Error("Demo token required");
      if (!token || token.length < 20 || token.length > 8192 || /\s/.test(token))
        throw new Error("Invalid token");
      const accounts = list(await api(token).request("GET", "/1/accounts"))
        .map(object)
        .map((a) => {
          if (typeof a.id !== "number") throw new Error("Invalid account");
          return { id: a.id, name: String(a.name ?? a.customer_name ?? "Account").slice(0, 200) };
        });
      if (
        !accounts.length ||
        accounts.length > 500 ||
        accounts.some((a) => !Number.isSafeInteger(a.id) || a.id <= 0)
      )
        throw new Error("Invalid accounts");
      // Revalidate after the provider await: an expired/cancelled flow must never be revived.
      const live = pending(req, id);
      if (live.csrf !== p.csrf || live.accounts) throw new Error("Connection changed");
      live.token = token;
      live.accounts = accounts;
      live.csrf = opaque();
      store.put("pending", fingerprint(id), live, Math.min(p.expires, now + 5 * 60_000));
      consentPolicy(res, live);
      res.type("html").send(connectPage(id, live));
    } catch {
      res
        .status(400)
        .type("html")
        .send(
          connectPage(
            id,
            p,
            "We couldn’t confirm account access. Check your token and its accounts permission, then start again.",
          ),
        );
    }
  });
  app.post("/connect/finish", async (req, res) => {
    const id = param(req, "request"),
      p = pending(req, id);
    csrf(req, p.csrf);
    consentPolicy(res, p);
    if (param(req, "decision") !== "allow") {
      store.delete("pending", fingerprint(id));
      const callback = new URL(p.redirect);
      callback.searchParams.set("error", "access_denied");
      callback.searchParams.set("iss", origin.href);
      if (p.state !== undefined) callback.searchParams.set("state", p.state);
      res.redirect(303, callback.href);
      return;
    }
    const account = Number(param(req, "account"));
    if (!p.accounts?.some((a) => a.id === account))
      throw new PluginError("account_required", "Choose an account shown on this page.");
    let writeZone: string | undefined;
    if (param(req, "enable_dns_test") === "yes") {
      if (!writes || !p.scopes?.includes(WRITE_SCOPE) || !p.token)
        throw new PluginError(
          "access_denied",
          "This connection did not request the disposable DNS scope.",
        );
      writeZone = param(req, "test_zone").trim().toLowerCase();
      if (
        !/^(?=.{3,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(writeZone) ||
        writeZone.includes("..")
      )
        throw new PluginError("invalid_input", "Choose an exact registered domain name.");
      await verifyWriteZone(api(p.token), account, writeZone);
      // The consent transaction may expire while the provider request is in flight.
      const live = pending(req, id);
      if (live.csrf !== p.csrf)
        throw new PluginError("connection_expired", "Start a new connection.");
    }
    let resources: ResourceConsent | undefined;
    if (param(req, "enable_resources") === "yes") {
      if (!writes || !options.resourceWrites || !p.token)
        throw new PluginError("access_denied", "Resource writes are unavailable.");
      const zones = resourceWords(param(req, "dns_zones")),
        addresses = resourceWords(param(req, "mailbox_addresses"));
      if (
        (zones.length && !p.scopes?.includes(DNS_SCOPE)) ||
        (addresses.length && !p.scopes?.includes(MAIL_SCOPE))
      )
        throw new PluginError(
          "access_denied",
          "This client did not request the selected resource access.",
        );
      if (!zones.length && !addresses.length && param(req, "deployment_enrollment") !== "yes")
        throw new PluginError(
          "invalid_input",
          "Enter domains or mailboxes, or uncheck changes to connect read-only.",
        );
      resources = await verifyResources(api(p.token), account, zones, addresses);
      if (param(req, "deployment_enrollment") === "yes") {
        if (!p.scopes?.includes(DEPLOY_SCOPE))
          throw new PluginError("access_denied", "This client did not request deployment access.");
        resources.deploymentEnrollment = true;
        resources.deployments = [];
      }
      if (pending(req, id).csrf !== p.csrf)
        throw new PluginError("connection_expired", "Start a new connection.");
    }
    let browser = cookie(req, oauth.manageCookie),
      owner = fingerprint(browser);
    if (!browser || !store.get<Browser>("browser", owner)) {
      browser = opaque();
      owner = fingerprint(browser);
      store.put(
        "browser",
        owner,
        { csrf: opaque() } satisfies Browser,
        store.now() + 30 * 86_400_000,
      );
    }
    const callback = oauth.complete(id, p, account, owner, writeZone, resources);
    count(req, "connection_approved");
    res.cookie(oauth.manageCookie, browser, {
      httpOnly: true,
      secure: origin.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 86_400_000,
    });
    if (!store.list<Pending>("pending").some(({ value }) => value.browser === p.browser))
      res.clearCookie(oauth.cookieName, {
        httpOnly: true,
        secure: origin.protocol === "https:",
        sameSite: "lax",
        path: "/",
      });
    res.redirect(303, callback);
  });
  mountDownloads(app, origin, (title, body, path = "/downloads") =>
    documentPage(title, body, previewNotice, {
      origin: origin.origin,
      path,
      description:
        path === "/plugins"
          ? "Download the open-source Infomaniak MCP plugin. Versioned packages, checksums, setup and contribution guide."
          : "Install and pair the customer-owned Infomaniak deployment runner. Versioned package, checksum and setup commands.",
    }),
  );
  deployments?.mount(app, { origin, manageCookie: oauth.manageCookie, cookie, csrf, page });
  mountOperations(app, { store, oauth, writes, page, cookie, csrf, canReview: canWrite });
  app.get("/connections", (req, res) => {
    const owner = fingerprint(cookie(req, oauth.manageCookie)),
      browser = store.get<Browser>("browser", owner);
    const grants = browser ? store.list<Grant>("grant").filter((r) => r.value.owner === owner) : [];
    res
      .type("html")
      .send(
        page(
          "Your connections",
          `<h1>Your connections.</h1><p><a href="/operations">Operations and change history</a></p><p class="lead">Connections authorized in this browser. Disconnecting immediately stops new requests and removes the live stored token. A provider request already in progress may finish.</p>${grants.length ? grants.map(({ id, value }) => `<section class="panel"><p class="account">Account ${value.account}</p><p>${e(store.get<{ client_name?: string }>("client", value.client)?.client_name ?? "AI app")} · ${value.resources ? e(value.resources.zones.length + " domains · " + value.resources.mailboxes.length + " mailboxes") : value.writeZone ? "disposable TXT API on " + e(value.writeZone) : "read-only"} · expires ${e(new Date(value.expires).toISOString().slice(0, 10))}</p><form action="/connections/revoke" method="post"><input type="hidden" name="csrf" value="${e(browser!.csrf)}"><input type="hidden" name="connection" value="${e(id)}"><a href="/connections/${e(id)}/access">Review permissions</a><br><button>Disconnect and delete token</button></form></section>`).join("") : '<section class="panel"><p>No active connections are available in this browser. To connect, start from your AI app. To stop a connection from another device, revoke its Infomaniak token or contact the operator.</p><a href="/">Connection instructions</a></section>'}`,
        ),
      );
  });
  app.post("/connections/revoke", (req, res) => {
    const owner = fingerprint(cookie(req, oauth.manageCookie)),
      browser = store.get<Browser>("browser", owner);
    if (!browser)
      throw new PluginError("connection_expired", "Open your connection management page first.");
    csrf(req, browser.csrf);
    const id = param(req, "connection"),
      grant = store.get<Grant>("grant", id);
    if (!grant || grant.owner !== owner)
      throw new PluginError("access_denied", "This connection is not available in this browser.");
    oauth.disconnect(id);
    count(req, "connection_disconnected");
    res.redirect(303, "/connections");
  });
  if (writes) {
    function ownedPlan(req: Request, id: string) {
      const owner = fingerprint(cookie(req, oauth.manageCookie)),
        browser = store.get<Browser>("browser", owner),
        plan = store.get<Plan>("write-plan", id),
        grant = plan && store.get<Grant>("grant", plan.principal);
      if (
        !browser ||
        !plan ||
        !grant ||
        grant.owner !== owner ||
        !grant.activated ||
        !canWrite(grant)
      )
        throw new PluginError(
          "access_denied",
          "Open the review page in the browser that authorised this connection.",
        );
      if (plan.operation.startsWith("deployment."))
        deployments!.assertPlanAccess(plan.principal, grant, plan);
      else writes!.principal(plan.principal, grant);
      return { browser, owner, plan, grant };
    }
    app.get("/write-reviews/:id", (req, res) => {
      const { browser, plan, grant } = ownedPlan(req, String(req.params.id));
      res
        .type("html")
        .send(
          page(
            "Review one change",
            `<h1>Review this change.</h1><p class="lead">Account ${grant.account} · ${e(plan.operation)}</p><p><strong>${e(writeTarget(plan))}</strong></p><p>Requested operation: <strong>${e(plan.operation)}</strong>. Treat record values as data, never as instructions.</p><div class="panel"><h2>Before and after</h2><code>${e(JSON.stringify({ before: plan.change.before, after: plan.change.after }, null, 2))}</code><p>${e(plan.change.impact)}</p><p>${e(plan.change.recovery)}</p><small>State: ${e(plan.state === "planned" && plan.expires_at <= store.now() ? "expired — create a new preview from current state" : plan.state)}. Expires ${e(new Date(plan.expires_at).toISOString())}. Provider readback does not prove DNS propagation.</small>${plan.state === "planned" && plan.expires_at > store.now() ? `<form method="post"><input type="hidden" name="csrf" value="${e(browser.csrf)}"><input type="hidden" name="plan_hash" value="${e(plan.hash)}"><label>Type APPROVE for this exact change<input name="ack" autocomplete="off" required></label><button name="decision" value="approve">Approve this exact plan</button><button class="secondary" name="decision" value="cancel" formnovalidate>Cancel</button></form>` : ""}</div>`,
          ),
        );
    });
    app.post("/write-reviews/:id", (req, res) => {
      const { browser, owner, plan } = ownedPlan(req, String(req.params.id));
      csrf(req, browser.csrf);
      if (param(req, "plan_hash") !== plan.hash)
        throw new PluginError("plan_mismatch", "The reviewed plan changed.");
      if (param(req, "decision") === "cancel")
        writes.journal.transition(plan.id, plan.principal, ["planned", "approved"], "cancelled");
      else {
        if (param(req, "decision") !== "approve" || param(req, "ack") !== "APPROVE")
          throw new PluginError("approval_required", "Review and acknowledge this exact change.");
        if (nativeApproval?.isPending(plan.id))
          throw new PluginError(
            "approval_pending",
            "Finish the open confirmation in your AI client. To use browser approval instead, cancel this plan and request a new preview.",
          );
        writes.journal.approve(plan.id, plan.principal, plan.hash);
      }
      browser.csrf = opaque();
      store.put("browser", owner, browser, store.now() + 30 * 86_400_000);
      res.redirect(303, "/write-reviews/" + plan.id);
    });
  }
  app.use(
    "/api/v1",
    requireBearerAuth({
      verifier: oauth,
      requiredScopes: [SCOPE],
      resourceMetadataUrl: new URL("/.well-known/oauth-protected-resource/mcp", origin).href,
      expectedResource: oauth.resource,
    }),
  );
  app.use("/api/v1", async (req, res) => {
    const id = req.auth?.extra?.grant,
      grant = typeof id === "string" ? store.get<Grant>("grant", id) : undefined;
    if (!grant || typeof id !== "string" || req.originalUrl.includes("?")) {
      res.status(403).json({ error: "writes_unavailable" });
      return;
    }
    if (req.headers.origin && req.headers.origin !== origin.origin) {
      res.status(403).json({ error: "unexpected_origin" });
      return;
    }
    if (atCapacity(id)) {
      res.status(429).json({ error: "too_many_requests" });
      return;
    }
    const release = reserveWork(id);
    try {
      const permitted = canWrite(grant);
      const principal = writes?.hasAccess(grant)
        ? writes.principal(id, grant)
        : {
            id,
            credential_env: "HOSTED_PROVIDER_TOKEN",
            accounts: [grant.account],
            operations: [],
            writes: "disabled" as const,
            resources: { zones: {}, dns_names: {}, mail_hostings: {}, mailboxes: {}, vps: {} },
          };
      await handleWriteApi(
        req,
        res,
        {
          dispatch: async (_p, name, args) => {
            if (name === "infomaniak_status")
              return {
                hosted: true,
                account_id: grant.account,
                writes_enabled: permitted,
                write_policy: deployments?.hasAccess(grant)
                  ? "enabled"
                  : writes?.hasAccess(grant)
                    ? writes.principal(id, grant).writes
                    : "disabled",
                available_reads: [
                  "accounts.list",
                  "products.list",
                  "resources.resolve",
                  ...[
                    ...(writes?.hasAccess(grant) ? writes.descriptors(grant) : []),
                    ...(deployments?.descriptors(grant) ?? []),
                  ]
                    .filter((d) => !d.write)
                    .map((d) => d.operation),
                ],
                available_writes: [
                  ...(writes?.hasAccess(grant) ? writes.descriptors(grant) : []),
                  ...(deployments?.descriptors(grant) ?? []),
                ].filter((d) => d.write),
                resources: grant.resources ?? null,
                ...(grant.writeZone
                  ? { zone: grant.writeZone, source: TEST_NAME, type: "TXT" }
                  : {}),
              };
            if (name !== "infomaniak_status" && deployments && isDeployment(id, args))
              return deployments.dispatch(id, grant, name, args);
            if (name === "infomaniak_read") {
              const discovery = await Discovery.create(grant.token, api(grant.token), [
                grant.account,
              ]);
              if (
                writes?.hasAccess(grant) &&
                object(args).operation !== "accounts.list" &&
                object(args).operation !== "products.list" &&
                object(args).operation !== "resources.resolve"
              )
                return writes.dispatch(id, grant, name, args);
              return discovery.dispatch(name, args);
            }
            if (!permitted)
              throw new PluginError(
                "writes_disabled",
                "A fresh connection with explicit disposable DNS consent is required.",
              );
            return writes!.dispatch(id, grant, name, args);
          },
        },
        principal,
        req.originalUrl,
        async () => JSON.stringify(req.body ?? {}),
        "/write-reviews",
      );
    } finally {
      release();
    }
  });
  app.use(
    "/mcp",
    (req, res, next) => {
      mcp.prune();
      const caller = req.headers.origin;
      if (
        caller &&
        ![origin.origin, "https://chatgpt.com", "https://claude.ai", "https://grok.com"].includes(
          caller,
        )
      ) {
        res.status(403).send("Unexpected origin.");
        return;
      }
      if (caller) {
        res.set("access-control-allow-origin", caller);
        res.set("access-control-expose-headers", "mcp-session-id");
        res.vary("Origin");
        res.set(
          "access-control-allow-headers",
          "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id",
        );
        res.set("access-control-allow-methods", "POST, DELETE, OPTIONS");
      }
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
    },
    requireBearerAuth({
      verifier: oauth,
      requiredScopes: [SCOPE],
      resourceMetadataUrl: new URL("/.well-known/oauth-protected-resource/mcp", origin).href,
      expectedResource: oauth.resource,
    }),
  );
  const mcp = new HostedMcp((id) => Boolean(store.get<Grant>("grant", id)?.activated), store.now);
  function connectionProtocol(id: string, initialGrant: Grant, sessionSignal?: AbortSignal) {
    return createProtocol(
      async (name, args, signal, interaction) => {
        let grant = store.get<Grant>("grant", id);
        if (!grant?.activated)
          throw new PluginError("access_denied", "This connection was disconnected.");
        if (name === "infomaniak_execute" && interaction.confirmWrite && nativeApproval) {
          const input = z
            .object({ plan_id: z.string().uuid(), plan_hash: z.string().regex(/^[a-f0-9]{64}$/) })
            .strict()
            .parse(args);
          const review = () => {
            const fresh = store.get<Grant>("grant", id);
            if (!fresh?.activated || !canWrite(fresh))
              throw new PluginError(
                "access_denied",
                "This connection no longer permits this change.",
              );
            const saved = writes!.journal.get(input.plan_id, id);
            return saved.operation.startsWith("deployment.")
              ? deployments!.review(id, fresh, input.plan_id, input.plan_hash)
              : writes!.review(id, fresh, input.plan_id, input.plan_hash);
          };
          const plan = await nativeApproval.confirm(
            review,
            interaction.confirmWrite,
            signal,
            new URL("/write-reviews/" + input.plan_id, origin).href,
          );
          if (plan.state === "cancelled") return { plan, provider_mutation_sent: false };
          grant = store.get<Grant>("grant", id);
          if (!grant?.activated)
            throw new PluginError("access_denied", "This connection was disconnected.");
        }
        if (
          deployments &&
          [
            "infomaniak_plan",
            "infomaniak_execute",
            "infomaniak_operation",
            "infomaniak_cancel",
            "infomaniak_read",
          ].includes(name) &&
          isDeployment(id, args)
        ) {
          const result = await deployments.dispatch(id, grant, name, args, signal);
          return {
            ...result,
            ...(name === "infomaniak_plan"
              ? {
                  approval_url: new URL("/write-reviews/" + (result.plan as Plan).id, origin).href,
                  approval_method: interaction.confirmWrite ? "client" : "browser",
                  next_step: interaction.confirmWrite
                    ? "Call infomaniak_execute with this exact plan id and hash. The client will ask the user to confirm before execution."
                    : "Open approval_url in the consenting browser before execution.",
                }
              : {}),
          };
        }
        if (
          [
            "infomaniak_plan",
            "infomaniak_execute",
            "infomaniak_operation",
            "infomaniak_cancel",
          ].includes(name) &&
          writes?.hasAccess(grant)
        ) {
          const result = await writes.dispatch(id, grant, name, args, signal);
          return {
            ...result,
            ...(name === "infomaniak_plan"
              ? {
                  approval_url: new URL("/write-reviews/" + (result.plan as Plan).id, origin).href,
                  approval_method: interaction.confirmWrite ? "client" : "browser",
                  next_step: interaction.confirmWrite
                    ? "Call infomaniak_execute with this exact plan id and hash. The client will ask the user to confirm before execution."
                    : "Open approval_url in the consenting browser before execution.",
                }
              : {}),
          };
        }
        if (
          name === "infomaniak_read" &&
          writes?.hasAccess(grant) &&
          !["accounts.list", "products.list", "resources.resolve"].includes(
            String(object(args).operation),
          )
        )
          return writes.dispatch(id, grant, name, args, signal);
        const discovery = await Discovery.create(grant.token, api(grant.token), [grant.account]);
        let result: Record<string, unknown>;
        try {
          result = boundedResult(await discovery.dispatch(name, args), [
            grant.token,
            interaction.oauthToken,
          ]);
          count({ headers: interaction.headers }, "tool_completed", name);
        } catch (error) {
          count({ headers: interaction.headers }, "tool_failed", name);
          if (error instanceof PluginError)
            throw new PluginError(
              error.code,
              String(redact(error.message, [grant.token, interaction.oauthToken])),
            );
          throw error;
        }
        if (name === "infomaniak_search" && canWrite(grant)) {
          const input = object(args),
            query = String(input.query ?? "").toLowerCase();
          const descriptors = [
            ...(writes?.hasAccess(grant) ? writes.descriptors(grant) : []),
            ...(deployments?.descriptors(grant) ?? []),
          ].filter((d) =>
            query
              .split(/\s+/)
              .some((word) =>
                (String(d.operation) + " " + String(d.summary)).toLowerCase().includes(word),
              ),
          );
          result = {
            ...result,
            operations: [...descriptors, ...list(result.operations)].slice(
              0,
              Number(input.limit) || 3,
            ),
          };
        }
        return name === "infomaniak_status"
          ? {
              ...result,
              ...(writes?.hasAccess(grant) ? writes.status(grant) : {}),
              ...(grant.scopes?.includes(DEPLOY_SCOPE)
                ? {
                    deployment_enabled: Boolean(deployments?.hasAccess(grant)),
                    deployment_apps: grant.resources?.deployments ?? [],
                    runner_setup_url: new URL("/runners", origin).href,
                    available_deployments: deployments?.descriptors(grant) ?? [],
                  }
                : {}),
              hosted: true,
              approval_method: interaction.confirmWrite ? "client" : "browser",
              writes_enabled: canWrite(grant),
              account_id: grant.account,
              ...(deployments?.hasAccess(grant)
                ? {
                    next_step:
                      "Inspect a paired app with deployment.app.get, then prepare deployment.release for a pinned commit. Follow the plan confirmation instructions before execution.",
                  }
                : !writes?.hasAccess(grant)
                  ? {
                      next_step: grant.scopes?.includes(DEPLOY_SCOPE)
                        ? "Open runner_setup_url in the consenting browser to pair your customer-owned deployment runner."
                        : "This connection can inspect its account and products. Connect again to grant named DNS or mailbox resources.",
                    }
                  : {}),
            }
          : result;
      },
      canWrite(initialGrant) || Boolean(initialGrant.scopes?.includes(DEPLOY_SCOPE)),
      !(canWrite(initialGrant) || Boolean(initialGrant.scopes?.includes(DEPLOY_SCOPE))),
      undefined,
      sessionSignal,
      () => reserveWork(id),
    );
  }
  const handleMcp = async (req: Request, res: Response) => {
    const id = req.auth?.extra?.grant;
    const grant = typeof id === "string" ? store.get<Grant>("grant", id) : undefined;
    if (!grant?.activated || typeof id !== "string") {
      res.sendStatus(401);
      return;
    }
    if (req.method === "POST" && !req.is("application/json")) {
      res.sendStatus(415);
      return;
    }
    // Responses to native prompts must remain deliverable when tool slots are full.
    const work = (Array.isArray(req.body) ? req.body : [req.body]).some(
      (message) => message?.method === "tools/call",
    );
    if (work && atCapacity(id)) {
      res.status(429).send("Please try again shortly.");
      return;
    }
    const permissions = fingerprint(
      JSON.stringify({
        account: grant.account,
        scopes: grant.scopes,
        resources: grant.resources,
        writeZone: grant.writeZone,
      }),
    );
    await mcp.handle(req, res, id, permissions, grant.account, (signal) =>
      connectionProtocol(id, grant, signal),
    );
  };
  app.post("/mcp", handleMcp);
  app.delete("/mcp", handleMcp);
  app.all("/mcp", (_req, res) => {
    res.set("allow", "POST, DELETE").sendStatus(405);
  });
  app.use((_req, res) => {
    res
      .status(404)
      .type("html")
      .send(
        page(
          "Page not found",
          '<h1>Let’s get you connected.</h1><p>This page is not available.</p><a class="button" href="/">Start here</a>',
        ),
      );
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const tooLarge = (error as { type?: string })?.type === "entity.too.large";
    res
      .status(tooLarge ? 413 : error instanceof PluginError ? 400 : 500)
      .type("html")
      .send(
        page(
          "Connection needs attention",
          `<h1>Let’s try that again.</h1><p>${e(error instanceof PluginError ? error.message : tooLarge ? "This request is too large." : "This connection could not finish. Start again from your AI app.")}</p><a class="button" href="/">Connection instructions</a>`,
        ),
      );
  });
  const server = createServer(app);
  server.once("close", () => mcp.close());
  if (writes) server.once("close", () => writes.journal.close());
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 40;
  server.maxConnections = 100;
  return { server, oauth };
}

export async function startHosted(): Promise<void> {
  const origin = new URL(process.env.INFOMANIAK_HOSTED_ORIGIN ?? ""),
    allowLoopback = process.env.INFOMANIAK_HOSTED_ALLOW_LOOPBACK === "true",
    writeSetting = process.env.INFOMANIAK_HOSTED_DISPOSABLE_DNS_WRITES;
  if (writeSetting !== undefined && !["true", "false"].includes(writeSetting))
    throw new PluginError("invalid_configuration", "Hosted DNS writes must be true or false.");
  if (
    process.env.INFOMANIAK_HOSTED_RESOURCE_WRITES !== undefined &&
    !["true", "false"].includes(process.env.INFOMANIAK_HOSTED_RESOURCE_WRITES)
  )
    throw new PluginError("invalid_configuration", "Hosted resource writes must be true or false.");
  if (
    process.env.INFOMANIAK_HOSTED_TRUST_PROXY_HOPS !== undefined &&
    !["0", "1"].includes(process.env.INFOMANIAK_HOSTED_TRUST_PROXY_HOPS)
  )
    throw new PluginError("invalid_configuration", "Hosted trusted proxy hops must be 0 or 1.");
  validateHostedOrigin(origin, allowLoopback);
  const directory = process.env.INFOMANIAK_HOSTED_STATE_DIR ?? "",
    keyFile = process.env.INFOMANIAK_HOSTED_KEY_FILE ?? "";
  if (!isAbsolute(directory))
    throw new PluginError(
      "configuration_required",
      "Configure the absolute hosted state directory and separate encryption key file.",
    );
  const store = new HostedStore(directory, readHostedKey(keyFile));
  const analytics = createHostedAnalytics(store);
  const { server } = createHosted({
    origin,
    store,
    allowLoopback,
    analytics,
    disposableDnsWrites: writeSetting !== "false",
    resourceWrites: process.env.INFOMANIAK_HOSTED_RESOURCE_WRITES !== "false",
    trustProxyHops: process.env.INFOMANIAK_HOSTED_TRUST_PROXY_HOPS === "1" ? 1 : 0,
  });
  const port = Number(process.env.INFOMANIAK_HOSTED_PORT ?? 8787);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    store.close();
    throw new PluginError("invalid_configuration", "Invalid hosted listener port.");
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    const host = allowLoopback
      ? "127.0.0.1"
      : (process.env.INFOMANIAK_HOSTED_BIND_HOST ?? "127.0.0.1");
    if (!["127.0.0.1", "0.0.0.0"].includes(host)) {
      reject(
        new PluginError(
          "invalid_configuration",
          "Use an explicit loopback or private-container listener.",
        ),
      );
      return;
    }
    server.listen(port, host, resolve);
  });
  const cleanup = setInterval(() => store.prune(), 60_000);
  cleanup.unref();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      clearInterval(cleanup);
      server.close(async () => {
        await analytics?.shutdown();
        store.close();
        process.exit(0);
      });
      server.closeIdleConnections();
    });
}
