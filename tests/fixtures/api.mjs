import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessSchema, digest } from "../../dist/access.js";
import { Application } from "../../dist/application.js";
import { ApiError } from "../../dist/provider.js";
import { OPERATIONS } from "../../dist/registry.js";

export const CLIENT_KEY = "fixture-client-key-".repeat(4);
export const HUMAN_KEY = "fixture-human-key-".repeat(4);
export const PROVIDER_KEY = "fixture-provider-key-".repeat(4);
export const clone = (value) => JSON.parse(JSON.stringify(value));
export class FixtureApi {
  records = [{ id: 1, source: "www", type: "A", target: "192.0.2.1", ttl: 3600 }];
  aliases = { enabled_alias: 1, aliases: ["existing"] };
  forwarding = {
    is_enabled: true,
    has_dont_deliver: false,
    has_forward_spam: false,
    redirect_adresses: [{ email: "old@example.net" }],
  };
  calls = [];
  failure = undefined;
  readFailure = false;
  gate = undefined;
  async request(method, path, body) {
    this.calls.push({ method, path, body: clone(body ?? null) });
    if (method === "GET") {
      if (this.readFailure) throw new ApiError(false);
      if (path === "/1/accounts")
        return [
          { id: 10, name: "Owner" },
          { id: 20, name: "Other" },
        ];
      if (path.startsWith("/1/products"))
        return [{ id: 30, type: "mail", billing_contact: "private@example.net" }];
      if (path.includes("/records")) return clone(this.records);
      if (path.endsWith("/aliases")) return clone(this.aliases);
      if (path.endsWith("/forwarding_addresses")) return clone(this.forwarding);
      if (path.endsWith("/mailboxes"))
        return [
          { name: "hello", email: "hello@example.com", users: [{ email: "private@example.net" }] },
        ];
      return { name: "hello", email: "hello@example.com", users: [{ password: "sensitive" }] };
    }
    if (this.gate) await this.gate;
    if (this.failure === "rejected") throw new ApiError(false, 403);
    if (path.includes("/records")) {
      if (method === "POST")
        this.records.push({
          id: Math.max(0, ...this.records.map((r) => r.id)) + 1,
          ...clone(body),
        });
      else if (method === "PUT")
        this.records = this.records.map((r) =>
          r.id === Number(path.split("/").at(-1)) ? { ...r, ...body } : r,
        );
      else this.records = this.records.filter((r) => r.id !== Number(path.split("/").at(-1)));
    } else if (path.includes("/aliases")) {
      if (method === "POST") this.aliases.aliases.push(body.alias);
      else
        this.aliases.aliases = this.aliases.aliases.filter(
          (v) => v !== decodeURIComponent(path.split("/").at(-1)),
        );
    } else if (path.includes("/forwarding_addresses")) {
      if (method === "POST")
        this.forwarding.redirect_adresses.push({ email: body.redirect_address });
      else if (method === "DELETE")
        this.forwarding.redirect_adresses = this.forwarding.redirect_adresses.filter(
          (r) => r.email !== decodeURIComponent(path.split("/").at(-1)),
        );
      else {
        for (const key of ["is_enabled", "has_dont_deliver", "has_forward_spam"])
          if (key in body) this.forwarding[key] = body[key];
        if (body.redirect_addresses)
          this.forwarding.redirect_adresses = body.redirect_addresses.map((email) => ({ email }));
        if (body.is_enabled === false) this.forwarding.redirect_adresses = [];
      }
    }
    if (this.failure === "uncertain") throw new ApiError(true);
    if (this.failure === "readback") this.readFailure = true;
    return { accepted: true };
  }
}
export function policy(directory, overrides = {}) {
  return AccessSchema.parse({
    version: 1,
    state_directory: join(directory, "state"),
    local_principal: "owner",
    principals: [
      {
        id: "owner",
        credential_env: "FIXTURE_PROVIDER",
        accounts: [10],
        access_token_sha256: digest(CLIENT_KEY),
        approval_token_sha256: digest(HUMAN_KEY),
        operations: [...OPERATIONS.keys()],
        writes: "disposable-only",
        resources: {
          zones: { "example.com": { account_id: 10, disposable: true, writable: true } },
          mail_hostings: { 30: { account_id: 10, disposable: false } },
          mailboxes: { "30:hello": { account_id: 10, disposable: true, writable: true } },
          vps: { 40: { account_id: 10, disposable: true, writable: true } },
        },
      },
    ],
    ...overrides,
  });
}
export async function fixture(t, overrides = {}, customize) {
  const directory = await mkdtemp(join(tmpdir(), "infomaniak-ai-test-"));
  const config = policy(directory, overrides),
    api = new FixtureApi();
  customize?.(config);
  const app = await Application.create(
    config,
    { FIXTURE_PROVIDER: PROVIDER_KEY, FIXTURE_PROVIDER_2: "fixture-other-provider-".repeat(4) },
    () => api,
  );
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await app.close();
    }
  };
  t.after(async () => {
    await close();
    await rm(directory, { recursive: true, force: true });
  });
  const principal = config.principals[0],
    engine = app.engines.get(principal.id);
  return {
    directory,
    config,
    api,
    app,
    principal,
    engine,
    close,
    call: (name, input = {}) => app.dispatch(principal, name, input),
  };
}
export const createArgs = {
  account_id: 10,
  zone: "example.com",
  source: "new",
  type: "A",
  target: "192.0.2.9",
  ttl: 300,
};
export const mailbox = { account_id: 10, mail_hosting_id: 30, mailbox_name: "hello" };
