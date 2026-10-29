import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { HostedStore, fingerprint } from "../../dist/hosted-store.js";
import { createHosted } from "../../dist/hosted.js";
import { DNS_SCOPE, MAIL_SCOPE, DEPLOY_SCOPE } from "../../dist/hosted-resources.js";
import { FixtureApi } from "./api.mjs";
export async function hostedFixture(t, options = {}) {
  const { now = () => Date.now(), lifetimeMs = 600000, ...runtimeOverrides } = options;
  const directory = await mkdtemp(join(tmpdir(), "ik-product-http-")),
    key = randomBytes(32),
    store = new HostedStore(directory, key, now);
  const reservation = createServer();
  await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const origin = new URL("http://127.0.0.1:" + port),
    api = new FixtureApi();
  api.domains = [{ id: 11, account_id: 10, service_name: "domain", customer_name: "example.com" }];
  const transport = {
    request: async (method, path, body) =>
      method === "GET" && path === "/1/products?account_id=10&per_page=1000"
        ? [
            ...api.domains,
            { id: 30, account_id: 10, service_name: "email_hosting", customer_name: "example.com" },
          ]
        : api.request(method, path, body),
  };
  const runtimeOptions = {
    origin,
    store,
    api: () => transport,
    allowLoopback: true,
    disposableDnsWrites: true,
    resourceWrites: true,
    ...runtimeOverrides,
  };
  let runtime = createHosted(runtimeOptions);
  await new Promise((r) => runtime.server.listen(port, "127.0.0.1", r));
  t.after(async () => {
    runtime.server.closeAllConnections();
    await new Promise((r) => runtime.server.close(r));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const browser = randomBytes(32).toString("base64url"),
    owner = fingerprint(browser),
    csrf = "fixture-browser-csrf",
    id = randomUUID(),
    access = "fixture-product-client-access",
    client = "fixture-product-client";
  const grant = {
    account: 10,
    owner,
    client,
    activated: true,
    token: "fixture-provider-token-for-http-tests",
    scopes: ["infomaniak:read", DNS_SCOPE, MAIL_SCOPE, DEPLOY_SCOPE],
    resources: {
      zones: ["example.com"],
      mailboxes: [{ hosting: 30, name: "hello", address: "hello@example.com" }],
      deploymentEnrollment: true,
      deployments: [],
    },
    created: now(),
    expires: now() + lifetimeMs,
  };
  store.put("browser", owner, { csrf }, grant.expires);
  store.put("grant", id, grant, grant.expires);
  store.put(
    "client",
    client,
    {
      client_id: client,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: "Fixture AI",
    },
    grant.expires,
  );
  store.put(
    "access",
    fingerprint(access),
    { grant: id, client, expires: Math.floor(grant.expires / 1000) },
    grant.expires,
  );
  const request = (path, options = {}) =>
    fetch(new URL(path, origin), {
      redirect: "manual",
      ...options,
      headers: { connection: "close", ...options.headers },
    });
  const json = (path, body, bearer = access) =>
    request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + bearer, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const form = (path, data, useBrowser = browser) =>
    request(path, {
      method: "POST",
      headers: {
        origin: origin.origin,
        cookie: "ik_manage=" + useBrowser,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(data),
    });
  return {
    origin,
    runtime,
    restart: async (whileStopped = () => {}) => {
      runtime.server.closeAllConnections();
      await new Promise((r) => runtime.server.close(r));
      whileStopped();
      runtime = createHosted(runtimeOptions);
      await new Promise((r) => runtime.server.listen(port, "127.0.0.1", r));
    },
    store,
    api,
    id,
    grant,
    access,
    browser,
    owner,
    csrf,
    request,
    json,
    form,
  };
}
