import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readdir, readFile, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createServer, request as rawRequest } from "node:http";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HostedStore, readHostedKey, fingerprint } from "../dist/hosted-store.js";
import { createHosted, validateHostedOrigin } from "../dist/hosted.js";
import { HostedOAuth, SCOPE, WRITE_SCOPE } from "../dist/hosted-oauth.js";

import { PluginError } from "../dist/errors.js";

const A = "fixture-hosted-customer-alpha-token",
  B = "fixture-hosted-customer-bravo-token";
const verifier = "v".repeat(50),
  challenge = createHash("sha256").update(verifier).digest("base64url");
const field = (html, name) => {
  const match = new RegExp('name="' + name + '" value="([^"]+)"').exec(html);
  assert(match, "Missing " + name);
  return match[1];
};
async function fixture(t, analytics, disposableDnsWrites = false) {
  const directory = await mkdtemp(join(tmpdir(), "ik-hosted-"));
  let now = Date.now(),
    store;
  const dnsRecords = [];
  const key = randomBytes(32),
    calls = [],
    faults = { products: false },
    customers = new Map([
      [A, [10, 20]],
      [B, [20, 30]],
    ]);
  const reservation = createServer();
  await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const origin = new URL("http://127.0.0.1:" + port);
  const api = (token) => ({
    request: async (method, path, body) => {
      calls.push({ token, method, path });
      if (disposableDnsWrites && path.startsWith("/2/zones/") && path.includes("/records")) {
        if (method === "GET") return structuredClone(dnsRecords);
        if (method === "POST") dnsRecords.push({ id: Date.now(), ...body });
        else if (method === "PUT") {
          const r = dnsRecords.find((r) => r.id === Number(path.split("/").at(-1)));
          Object.assign(r, body);
        } else if (method === "DELETE") {
          const index = dnsRecords.findIndex((r) => r.id === Number(path.split("/").at(-1)));
          if (index >= 0) dnsRecords.splice(index, 1);
        }
        return true;
      }
      assert.equal(method, "GET");
      if (!customers.has(token)) throw new Error("Never echo " + token);
      if (path === "/1/accounts")
        return customers.get(token).map((id) => ({
          id,
          name: id === 10 ? "Alpha <script>untrusted</script>" : "Account " + id,
        }));
      if (path.startsWith("/1/products?")) {
        if (faults.products) throw new PluginError("provider_error", "Provider echoed " + token);
        const id = Number(
          new URL(path, "https://api.infomaniak.com").searchParams.get("account_id"),
        );
        return [
          {
            id: id * 100,
            account_id: id,
            service_name: "domain",
            customer_name: "example-" + id + ".com",
          },
        ];
      }
      throw new Error("Unexpected fixture route");
    },
  });
  const open = () => {
    store = new HostedStore(directory, key, () => now);
    return createHosted({
      origin,
      store,
      api,
      allowLoopback: true,
      analytics,
      disposableDnsWrites,
    });
  };
  let runtime = open();
  await new Promise((r) => runtime.server.listen(port, "127.0.0.1", r));
  t.after(async () => {
    runtime.server.closeAllConnections();
    await new Promise((r) => runtime.server.close(r));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = (path, options = {}) =>
    fetch(new URL(path, origin), { ...options, redirect: "manual" });
  const form = (path, data, cookies = "", extra = {}) =>
    request(path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: origin.origin,
        ...(cookies ? { cookie: cookies } : {}),
        ...extra,
      },
      body: new URLSearchParams(data),
    });
  const register = async (name = "Fixture AI", other = {}) => {
    const res = await request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: ["https://ai.example/callback"],
        token_endpoint_auth_method: "none",
        ...other,
      }),
    });
    assert.equal(res.status, 201, await res.clone().text());
    return res.json();
  };
  const begin = async (client, other = {}) => {
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: new URL("/mcp", origin).href,
      scope: SCOPE,
      state: "opaque-state",
      ...other,
    });
    for (const [key, value] of Object.entries(other)) if (value === null) params.delete(key);
    const response = await request("/authorize?" + params);
    return response;
  };
  const consent = async (client, token = A, account = 10, extra = {}) => {
    const start = await begin(
      client,
      extra.enable_dns_test ? { scope: SCOPE + " " + WRITE_SCOPE } : {},
    );
    assert.equal(start.status, 303, await start.clone().text());
    const cookie = start.headers.getSetCookie()[0].split(";")[0];
    const location = start.headers.get("location"),
      transaction = new URL(location, origin).searchParams.get("request");
    const html = await (await request(location, { headers: { cookie } })).text();
    const response = await form(
      "/connect/token",
      { request: transaction, csrf: field(html, "csrf"), provider_token: token },
      cookie,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const accounts = await response.text();
    assert(!accounts.includes(token));
    const finish = await form(
      "/connect/finish",
      {
        request: transaction,
        csrf: field(accounts, "csrf"),
        account: String(account),
        decision: "allow",
        ...extra,
      },
      cookie,
    );
    assert.equal(finish.status, 303, await finish.clone().text());
    const callback = new URL(finish.headers.get("location"));
    assert.equal(callback.searchParams.get("state"), "opaque-state");
    const manage = finish.headers
      .getSetCookie()
      .find((c) => c.startsWith("ik_manage="))
      .split(";")[0];
    return { code: callback.searchParams.get("code"), manage, cookie, transaction, accounts };
  };
  const exchange = (client, code, other = {}) =>
    form("/token", {
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: client.redirect_uris[0],
      resource: new URL("/mcp", origin).href,
      ...other,
    });
  const connect = async (token) => {
    const client = new Client({ name: "hosted-integration-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", origin), {
        requestInit: { headers: { authorization: "Bearer " + token } },
      }),
    );
    t.after(() => client.close());
    return client;
  };
  return {
    directory,
    key,
    calls,
    faults,
    dnsRecords,
    customers,
    origin,
    request,
    form,
    register,
    begin,
    consent,
    exchange,
    connect,
    get store() {
      return store;
    },
    get oauth() {
      return runtime.oauth;
    },
    advance: (ms) => {
      now += ms;
    },
    restart: async () => {
      runtime.server.closeAllConnections();
      await new Promise((r) => runtime.server.close(r));
      store.close();
      runtime = open();
      await new Promise((r) => runtime.server.listen(port, "127.0.0.1", r));
    },
  };
}

test("hosted analytics hooks record outcomes without account or credential data", async (t) => {
  const events = [];
  const f = await fixture(t, {
    record: (event, tool) => events.push({ event, ...(tool ? { tool } : {}) }),
    shutdown: async () => {},
  });
  await f.request("/");
  assert.match(await (await f.request("/privacy")).text(), /PostHog in the EU/);
  const registration = await f.register();
  const consent = await f.consent(registration);
  const token = await (await f.exchange(registration, consent.code)).json();
  const client = await f.connect(token.access_token);
  await client.callTool({ name: "infomaniak_status", arguments: {} });
  const denied = await client.callTool({
    name: "infomaniak_read",
    arguments: { operation: "products.list", arguments: { account_id: 20 } },
  });
  assert(denied.isError);
  const html = await (
    await f.request("/connections", { headers: { cookie: consent.manage } })
  ).text();
  const revoke = await f.form(
    "/connections/revoke",
    { csrf: field(html, "csrf"), connection: field(html, "connection") },
    consent.manage,
  );
  assert.equal(revoke.status, 303);
  assert.deepEqual(events, [
    { event: "homepage_viewed" },
    { event: "connection_approved" },
    { event: "tool_completed", tool: "infomaniak_status" },
    { event: "tool_failed", tool: "infomaniak_read" },
    { event: "connection_disconnected" },
  ]);
});

test("hosted metadata advertises OAuth PKCE, a resource audience and credential-free onboarding", async (t) => {
  const f = await fixture(t);
  const home = await f.request("/");
  assert.equal(home.status, 200);
  assert.equal(home.headers.get("referrer-policy"), "no-referrer");
  assert.match(await home.text(), /ChatGPT/);
  for (const client of ["chatgpt", "claude", "grok"]) {
    const guide = await f.request("/clients/" + client);
    assert.equal(guide.status, 200);
    const content = await guide.text();
    assert(content.includes(new URL("/mcp", f.origin).href));
    assert(!content.includes('name="provider_token"'));
  }
  const denied = await f.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("www-authenticate"), /resource_metadata/);
  const resource = await (await f.request("/.well-known/oauth-protected-resource/mcp")).json();
  assert.equal(resource.resource, new URL("/mcp", f.origin).href);
  const metadata = await (await f.request("/.well-known/oauth-authorization-server")).json();
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.equal(metadata.registration_endpoint, new URL("/register", f.origin).href);
  for (const token of [A, B, "fixture-separate-human-approval-token"])
    assert.equal(
      (await f.request("/mcp", { headers: { authorization: "Bearer " + token } })).status,
      401,
    );
  assert.equal(f.calls.length, 0);
});
test("hosted rejects excessive validation fan-out and nesting before registering a client", async (t) => {
  const f = await fixture(t);
  let nested = {};
  for (let i = 0; i < 18; i++) nested = { child: nested };
  for (const extra of [
    { list: Array(65).fill({}) },
    { map: Object.fromEntries(Array.from({ length: 129 }, (_, i) => ["k" + i, i])) },
    { matrix: Array.from({ length: 64 }, () => Array(8).fill({})) },
    nested,
  ]) {
    const body = JSON.stringify({
      client_name: "Untrusted metadata",
      redirect_uris: ["https://ai.example/callback"],
      extra,
    });
    assert(Buffer.byteLength(body) < 16_384);
    const response = await f.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(response.status, 400);
    assert.equal(await response.text(), "Request structure exceeds its budget.");
    assert.equal((await f.request("/healthz")).status, 200);
  }
  assert.equal(f.store.list("client").length, 0);
  assert.equal(f.calls.length, 0);
  await f.register();
});
test("compressed frames with trailing bytes cannot reach the request decoder", async (t) => {
  const f = await fixture(t);
  const body = Buffer.concat([
    gzipSync(Buffer.from('{"client_name":"Fixture"}')),
    Buffer.from("trailing bytes"),
  ]);
  const response = await f.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
    body,
  });
  assert.equal(response.status, 413);
  assert.equal((await f.request("/healthz")).status, 200);
  assert.equal(f.store.list("client").length, 0);
  await f.register();
});
test("browser consent and a standard MCP SDK client expose only the explicitly chosen account", async (t) => {
  const f = await fixture(t),
    registered = await f.register(),
    consent = await f.consent(registered);
  assert(consent.accounts.includes("&lt;script&gt;"));
  assert(!consent.accounts.includes("<script>"));
  const response = await f.exchange(registered, consent.code);
  assert.equal(response.status, 200, await response.clone().text());
  const tokens = await response.json();
  assert.notEqual(tokens.access_token, A);
  assert.equal(tokens.scope, SCOPE);
  const client = await f.connect(tokens.access_token);
  assert.equal((await client.listTools()).tools.length, 6);
  const status = (await client.callTool({ name: "infomaniak_status", arguments: {} }))
    .structuredContent;
  assert.equal(status.writes_enabled, false);
  assert.equal(status.hosted, true);
  assert.equal(status.account_id, 10);
  const accounts = await client.callTool({
    name: "infomaniak_read",
    arguments: { operation: "accounts.list" },
  });
  assert.deepEqual(
    accounts.structuredContent.data.map((x) => x.id),
    [10],
  );
  const before = f.calls.length;
  const denied = await client.callTool({
    name: "infomaniak_read",
    arguments: { operation: "products.list", arguments: { account_id: 20 } },
  });
  assert(denied.isError);
  assert(f.calls.slice(before).every((x) => x.path === "/1/accounts"));
  const products = await client.callTool({
    name: "infomaniak_read",
    arguments: { operation: "products.list", arguments: { account_id: 10 } },
  });
  assert.equal(products.structuredContent.data[0].id, 1000);
  f.faults.products = true;
  const error = await client.callTool({
    name: "infomaniak_read",
    arguments: { operation: "products.list", arguments: { account_id: 10 } },
  });
  assert(error.isError);
  assert(!JSON.stringify(error).includes(A));
  assert(JSON.stringify(error).includes("redacted"));
  f.faults.products = false;
  const mutation = await client.callTool({
    name: "infomaniak_execute",
    arguments: { approved: true },
  });
  assert(mutation.isError);
  assert(f.calls.every((x) => x.method === "GET"));
  assert(!JSON.stringify({ tokens, status, accounts, products, denied, mutation }).includes(A));
});
test("a new provider customer can self-enroll on the shared endpoint without operator provisioning", async (t) => {
  const f = await fixture(t),
    registered = await f.register("Shared AI app"),
    original = await f.consent(registered),
    originalTokens = await (await f.exchange(registered, original.code)).json(),
    originalClient = await f.connect(originalTokens.access_token);
  assert.equal(f.store.list("grant").length, 1);

  // This represents a customer newly known to Infomaniak, not gateway configuration.
  // Only the provider fixture changes after the shared gateway has already started.
  const token = "fixture-new-customer-" + randomBytes(24).toString("hex"),
    account = 1000 + randomBytes(4).readUInt32BE();
  f.customers.set(token, [account, account + 1]);
  const newcomer = await f.consent(registered, token, account),
    response = await f.exchange(registered, newcomer.code);
  assert.equal(response.status, 200, await response.clone().text());
  const tokens = await response.json(),
    client = await f.connect(tokens.access_token);
  assert.notEqual(tokens.access_token, originalTokens.access_token);
  assert.equal(f.store.list("grant").length, 2);
  const readAccounts = async (connection) =>
    (
      await connection.callTool({
        name: "infomaniak_read",
        arguments: { operation: "accounts.list" },
      })
    ).structuredContent.data.map((row) => row.id);
  assert.deepEqual(await readAccounts(client), [account]);
  assert.deepEqual(await readAccounts(originalClient), [10]);

  const before = f.calls.length;
  for (const id of [10, account + 1]) {
    const denied = await client.callTool({
      name: "infomaniak_read",
      arguments: { operation: "products.list", arguments: { account_id: id } },
    });
    assert(denied.isError);
  }
  assert(f.calls.slice(before).every((call) => call.path === "/1/accounts"));
  const products = await client.callTool({
    name: "infomaniak_read",
    arguments: { operation: "products.list", arguments: { account_id: account } },
  });
  assert.equal(products.structuredContent.data[0].id, account * 100);
  assert(f.calls.every((call) => call.method === "GET"));
  assert(!JSON.stringify({ newcomer, tokens, products }).includes(token));
});
test("authorization codes bind client, PKCE, redirect and audience and are single use", async (t) => {
  const f = await fixture(t),
    client = await f.register(),
    other = await f.register("Other AI"),
    c = await f.consent(client);
  for (const [who, override] of [
    [other, {}],
    [client, { code_verifier: "wrong".repeat(12) }],
    [client, { redirect_uri: "https://evil.example/callback" }],
    [client, { resource: "https://evil.example/mcp" }],
  ]) {
    const res = await f.exchange(who, c.code, override);
    assert.equal(res.status, 400);
    assert(!JSON.stringify(await res.json()).includes(A));
  }
  assert.equal((await f.exchange(client, c.code)).status, 200);
  assert.equal((await f.exchange(client, c.code)).status, 400);
});
test("refresh rotation detects replay and invalidates the whole connection without affecting another tenant", async (t) => {
  const f = await fixture(t),
    ca = await f.register(),
    cb = await f.register("Other AI");
  const a = await f.consent(ca),
    b = await f.consent(cb, B, 30);
  const ta = await (await f.exchange(ca, a.code)).json(),
    tb = await (await f.exchange(cb, b.code)).json();
  const refresh = (other) =>
    f.form("/token", {
      grant_type: "refresh_token",
      client_id: ca.client_id,
      refresh_token: ta.refresh_token,
      resource: new URL("/mcp", f.origin).href,
      ...other,
    });
  assert.equal((await refresh({ scope: "infomaniak:write" })).status, 400);
  assert.equal((await refresh({ resource: "https://evil.example/mcp" })).status, 400);
  const rotated = await refresh({});
  assert.equal(rotated.status, 200);
  const newer = await rotated.json();
  assert.notEqual(newer.refresh_token, ta.refresh_token);
  assert.equal((await refresh({})).status, 400);
  await assert.rejects(f.oauth.verifyAccessToken(newer.access_token));
  await assert.rejects(f.oauth.verifyAccessToken(ta.access_token));
  assert.equal((await f.oauth.verifyAccessToken(tb.access_token)).clientId, cb.client_id);
});
test("consent requires the right browser, fresh CSRF, same origin and a verified account", async (t) => {
  const f = await fixture(t),
    client = await f.register(),
    begin = await f.begin(client);
  const cookie = begin.headers.getSetCookie()[0].split(";")[0],
    location = begin.headers.get("location"),
    id = new URL(location, f.origin).searchParams.get("request");
  const html = await (await f.request(location, { headers: { cookie } })).text(),
    csrf = field(html, "csrf");
  assert.equal((await f.request(location)).status, 400);
  for (const [cookies, change, extra] of [
    ["", {}, {}],
    [cookie, { csrf: "wrong" }, {}],
    [cookie, {}, { origin: "https://evil.example" }],
    [cookie, {}, { origin: "null" }],
  ])
    assert.equal(
      (
        await f.form(
          "/connect/token",
          { request: id, csrf, provider_token: A, ...change },
          cookies,
          extra,
        )
      ).status,
      400,
    );
  assert.equal(f.calls.length, 0);
  const invalid = await f.form(
    "/connect/token",
    { request: id, csrf, provider_token: "invalid-token-" + A },
    cookie,
  );
  assert.equal(invalid.status, 400);
  assert(!(await invalid.text()).includes(A));
  assert.equal(f.store.list("grant").length, 0);
  const verified = await f.form("/connect/token", { request: id, csrf, provider_token: A }, cookie),
    accounts = await verified.text();
  assert.equal(
    (
      await f.form(
        "/connect/finish",
        { request: id, csrf, account: "10", decision: "allow" },
        cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.form(
        "/connect/finish",
        { request: id, csrf: field(accounts, "csrf"), account: "999", decision: "allow" },
        cookie,
      )
    ).status,
    400,
  );
  const cancel = await f.form(
    "/connect/finish",
    { request: id, csrf: field(accounts, "csrf"), decision: "cancel" },
    cookie,
  );
  assert.equal(cancel.status, 303);
  assert.equal(new URL(cancel.headers.get("location")).searchParams.get("error"), "access_denied");
  assert.equal(f.store.list("pending").length, 0);
  assert.equal(f.store.list("grant").length, 0);
});
test("management consent and OAuth revocation delete stored provider tokens and refuse cross-browser access", async (t) => {
  const f = await fixture(t),
    ca = await f.register(),
    cb = await f.register("Other AI"),
    a = await f.consent(ca),
    b = await f.consent(cb, B, 30);
  const ta = await (await f.exchange(ca, a.code)).json(),
    tb = await (await f.exchange(cb, b.code)).json();
  const html = await (await f.request("/connections", { headers: { cookie: a.manage } })).text();
  assert(html.includes("Account 10"));
  assert(!html.includes("Account 30"));
  assert(!html.includes(A));
  const grant = field(html, "connection"),
    csrf = field(html, "csrf");
  assert.equal(
    (await f.form("/connections/revoke", { connection: grant, csrf }, b.manage)).status,
    400,
  );
  assert.equal(
    (await f.form("/connections/revoke", { connection: grant, csrf: "wrong" }, a.manage)).status,
    400,
  );
  assert.equal(
    (await f.form("/connections/revoke", { connection: grant, csrf }, a.manage)).status,
    303,
  );
  await assert.rejects(f.oauth.verifyAccessToken(ta.access_token));
  assert(!f.store.list("grant").some((x) => x.value.token === A));
  await f.oauth.verifyAccessToken(tb.access_token);
  const revoked = await f.form("/revoke", {
    client_id: cb.client_id,
    token: tb.refresh_token,
    token_type_hint: "refresh_token",
  });
  assert.equal(revoked.status, 200);
  assert.equal(f.store.list("grant").length, 0);
});
test("expired consent, codes, access and connection credentials cannot be revived", async (t) => {
  const f = await fixture(t),
    client = await f.register(),
    c = await f.consent(client);
  f.advance(61_000);
  f.store.prune();
  assert.equal(f.store.list("grant").length, 0);
  assert.equal((await f.exchange(client, c.code)).status, 400);
  const d = await f.consent(client),
    tokens = await (await f.exchange(client, d.code)).json();
  f.advance(16 * 60_000);
  await assert.rejects(f.oauth.verifyAccessToken(tokens.access_token));
  const renewed = await f.form("/token", {
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: tokens.refresh_token,
  });
  assert.equal(renewed.status, 200);
  const fresh = await renewed.json();
  f.advance(31 * 86_400_000);
  assert.equal(
    (
      await f.form("/token", {
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: fresh.refresh_token,
      })
    ).status,
    400,
  );
  f.store.prune();
  assert.equal(f.store.list("grant").length, 0);
});
test("encrypted state survives restart, rejects another key and never stores raw provider or OAuth tokens", async (t) => {
  const f = await fixture(t),
    client = await f.register(),
    c = await f.consent(client),
    tokens = await (await f.exchange(client, c.code)).json();
  for (const file of await readdir(f.directory)) {
    const bytes = await readFile(join(f.directory, file));
    for (const value of [A, tokens.access_token, tokens.refresh_token, c.code])
      assert(!bytes.includes(Buffer.from(value)));
  }
  await f.restart();
  await f.oauth.verifyAccessToken(tokens.access_token);
  assert.throws(() => new HostedStore(f.directory, randomBytes(32)), {
    code: "invalid_hosted_key",
  });
  await f.oauth.verifyAccessToken(tokens.access_token);
  assert.throws(() => new HostedOAuth(f.store, new URL("https://other-resource.example")), {
    code: "hosted_origin_changed",
  });
  await f.oauth.verifyAccessToken(tokens.access_token);
});
test("redirects, scope expansion, foreign hosts/origins, oversized bodies and credential-bearing MCP URLs fail", async (t) => {
  const f = await fixture(t),
    client = await f.register();
  for (const redirect of [
    "http://evil.example/cb",
    "https://user:password@evil.example/cb",
    "https://ai.example/cb#fragment",
  ]) {
    const r = await f.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
    });
    assert.equal(r.status, 400);
  }
  assert.equal(
    (await f.begin(client, { redirect_uri: "https://evil.example/callback" })).status,
    400,
  );
  for (const override of [
    { code_challenge_method: "plain" },
    { scope: "infomaniak:write" },
    { resource: "https://evil.example/mcp" },
  ]) {
    const r = await f.begin(client, override);
    assert.equal(r.status, 302);
    assert(!new URL(r.headers.get("location")).searchParams.has("code"));
  }
  const foreignHost = await new Promise((resolve) => {
    const r = rawRequest(
      new URL("/healthz", f.origin),
      { headers: { host: "evil.example" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    r.end();
  });
  assert.equal(foreignHost, 403);
  assert.equal(
    (await f.request("/mcp", { headers: { origin: "https://evil.example" } })).status,
    403,
  );
  const large = await f.form("/connect/token", { provider_token: A.repeat(900) });
  assert.equal(large.status, 413);
  assert.equal((await f.request("/mcp?token=" + A)).status, 400);
  assert.equal(f.calls.length, 0);
});
test("hosted initialization keeps keys private, refuses Git and existing directories, and defaults to HTTPS", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ik-hosted-init-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = new URL("../dist/hosted-admin.js", import.meta.url),
    profile = join(directory, "private");
  const args = [entry.pathname, "init", "--directory", profile];
  assert.equal(spawnSync(process.execPath, args, { encoding: "utf8" }).status, 0);
  const key = await readFile(join(profile, "hosted-key"), "utf8");
  assert.equal(key.trim().length, 43);
  assert.equal(readHostedKey(join(profile, "hosted-key")).length, 32);
  const again = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.notEqual(again.status, 0);
  assert(!again.stderr.includes(key.trim()));
  assert.equal(await readFile(join(profile, "hosted-key"), "utf8"), key);
  await writeFile(join(directory, ".git"), "fixture");
  assert.notEqual(
    spawnSync(
      process.execPath,
      [entry.pathname, "init", "--directory", join(directory, "refused")],
      { encoding: "utf8" },
    ).status,
    0,
  );
  assert.throws(() => validateHostedOrigin(new URL("http://example.com")));
  assert.throws(() => validateHostedOrigin(new URL("https://example.com/path")));
  validateHostedOrigin(new URL("https://example.com"));
  validateHostedOrigin(new URL("http://127.0.0.1"), true);
  const unsafe = join(directory, "unsafe");
  await writeFile(unsafe, "fixture");
  await symlink(unsafe, join(directory, "link"));
  assert.throws(() => readHostedKey(join(directory, "link")), { code: "unsafe_hosted_storage" });
  if (process.platform !== "win32") {
    await chmod(directory, 0o755);
    assert.throws(() => new HostedStore(directory, randomBytes(32)), {
      code: "unsafe_hosted_storage",
    });
    await chmod(directory, 0o700);
  }
});

test("abandoned consent expires and store transactions do not retain partial credentials", async (t) => {
  const f = await fixture(t),
    client = await f.register(),
    begin = await f.begin(client);
  const cookie = begin.headers.getSetCookie()[0].split(";")[0];
  const location = begin.headers.get("location");
  f.advance(11 * 60_000);
  assert.equal((await f.request(location, { headers: { cookie } })).status, 400);
  f.store.prune();
  assert.equal(f.store.list("pending").length, 0);
  assert.throws(() =>
    f.store.atomic(() => {
      f.store.put("probe", "partial", { token: A }, f.store.now() + 60_000);
      throw new Error("fixture rollback");
    }),
  );
  assert.equal(f.store.get("probe", "partial"), undefined);
});

test("confidential OAuth clients keep secrets encrypted and authenticate exchange, refresh and revocation", async (t) => {
  const f = await fixture(t);
  const client = await f.register("Confidential AI", {
    token_endpoint_auth_method: "client_secret_post",
  });
  assert(client.client_secret);
  assert.equal(client.client_secret_expires_at, 0);
  const consent = await f.consent(client);
  assert(!consent.accounts.includes(client.client_secret));
  assert.equal((await f.exchange(client, consent.code)).status, 400);
  assert.equal(
    (await f.exchange(client, consent.code, { client_secret: "incorrect" })).status,
    400,
  );
  const response = await f.exchange(client, consent.code, { client_secret: client.client_secret });
  assert.equal(response.status, 200);
  const tokens = await response.json();
  const refreshed = await f.form("/token", {
    grant_type: "refresh_token",
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: tokens.refresh_token,
  });
  assert.equal(refreshed.status, 200);
  const next = await refreshed.json();
  assert.equal(
    (await f.form("/revoke", { client_id: client.client_id, token: next.refresh_token })).status,
    400,
  );
  assert.equal(
    (
      await f.form("/revoke", {
        client_id: client.client_id,
        client_secret: client.client_secret,
        token: next.refresh_token,
      })
    ).status,
    200,
  );
  await assert.rejects(f.oauth.verifyAccessToken(next.access_token));
  for (const file of await readdir(f.directory))
    assert(!(await readFile(join(f.directory, file))).includes(Buffer.from(client.client_secret)));
});

test("public reference pages expose no customer data, set no cookies and keep private routes out of search", async (t) => {
  const events = [];
  const f = await fixture(t, { record: (...args) => events.push(args), shutdown: async () => {} });
  const paths = [
    "/",
    "/api",
    "/privacy",
    "/cookies",
    "/clients/claude",
    "/clients/chatgpt",
    "/clients/grok",
    "/clients/other",
  ];
  for (const path of paths) {
    const response = await f.request(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("set-cookie"), null, path);
    const html = await response.text();
    assert(html.includes('rel="canonical" href="' + new URL(path, f.origin).href + '"'), path);
    assert(html.includes('content="index,follow"'), path);
    assert(html.includes("https://leonhoulier.com"), path);
    assert(!html.includes(A) && !html.includes(B), path);
  }
  const info = await (await f.request("/api/capabilities")).json();
  assert.equal(info.writes_enabled, false);
  assert.equal(info.tools.length, 6);
  assert.equal(info.mcp_url, new URL("/mcp", f.origin).href);
  assert(!JSON.stringify(info).includes("account_id"));
  assert.equal(f.calls.length, 0);
  const sitemap = await (await f.request("/sitemap.xml")).text();
  assert(!sitemap.includes("/connections") && !sitemap.includes("/connect?"));
  assert(sitemap.includes(new URL("/api", f.origin).href));
  const reference = await (await f.request("/llms.txt")).text();
  assert(reference.includes("No hosted writes"));
  assert.equal((await f.request("/connections")).headers.get("x-robots-tag"), "noindex, nofollow");
  const missing = await f.request("/missing");
  assert.equal(missing.status, 404);
  assert((await missing.text()).includes('content="noindex,nofollow"'));
  for (const name of ["Regular", "Medium", "SemiBold"]) {
    const font = await f.request("/fonts/IBMPlexSans-" + name + ".woff2");
    assert.equal(font.status, 200);
    assert.equal(font.headers.get("content-type"), "font/woff2");
    assert.equal(font.headers.get("set-cookie"), null);
    const bytes = Buffer.from(await font.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), "wOF2");
  }
  assert.equal((await f.request("/fonts/unlisted.woff2")).status, 404);
  assert.equal((await f.request("/fonts/LICENSE.txt")).status, 404);
  const social = await f.request("/social.png");
  assert.equal(social.status, 200);
  assert.equal(social.headers.get("content-type"), "image/png");
  const png = Buffer.from(await social.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  const home = await f.request("/");
  const html = await home.text();
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const hash = createHash("sha256").update(script).digest("base64");
  assert(home.headers.get("content-security-policy").includes("'sha256-" + hash + "'"));
  assert.match(home.headers.get("content-security-policy"), /font-src 'self'/);
  assert.match(home.headers.get("content-security-policy"), /script-src 'sha256-/);
  assert(!home.headers.get("content-security-policy").includes("script-src 'unsafe-inline'"));
});

test("GPC and Do Not Track suppress request usage counts without blocking access", async (t) => {
  const events = [];
  const f = await fixture(t, { record: (...args) => events.push(args), shutdown: async () => {} });
  for (const headers of [{ "sec-gpc": "1" }, { dnt: "1" }])
    assert.equal((await f.request("/", { headers })).status, 200);
  assert.deepEqual(events, []);
  await f.request("/");
  assert.deepEqual(events, [["homepage_viewed", undefined]]);
});

async function defaultConsent(f, client, enableWrites) {
  const start = await f.begin(client, { scope: null });
  assert.equal(start.status, 303);
  const cookie = start.headers.getSetCookie()[0].split(";")[0],
    location = start.headers.get("location"),
    request = new URL(location, f.origin).searchParams.get("request");
  const html = await (await f.request(location, { headers: { cookie } })).text();
  const response = await f.form(
    "/connect/token",
    { request, csrf: field(html, "csrf"), provider_token: A },
    cookie,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("referrer-policy"), "same-origin");
  const consent = await response.text();
  const finish = await f.form(
    "/connect/finish",
    {
      request,
      csrf: field(consent, "csrf"),
      account: "10",
      decision: "allow",
      ...(enableWrites ? { enable_dns_test: "yes", test_zone: "example-10.com" } : {}),
    },
    cookie,
  );
  assert.equal(finish.status, 303);
  const code = new URL(finish.headers.get("location")).searchParams.get("code");
  return { consent, tokens: await (await f.exchange(client, code)).json() };
}

test("new unscoped connections offer writes by default and issue them only after domain consent", async (t) => {
  const f = await fixture(t, undefined, true),
    client = await f.register("Default access");
  const { consent, tokens } = await defaultConsent(f, client, true);
  assert.match(consent, /name="enable_dns_test" value="yes" checked/);
  assert.match(consent, /Uncheck Enable DNS writes for read-only access/);
  assert.equal(tokens.scope, SCOPE + " " + WRITE_SCOPE);
  const ai = await f.connect(tokens.access_token);
  assert.equal((await ai.listTools()).tools.length, 10);
  const capabilities = await (await f.request("/api/capabilities")).json();
  assert.equal(capabilities.default_connection, "read-write-with-consent");
  assert.deepEqual(capabilities.default_scopes, [SCOPE, WRITE_SCOPE]);
  assert.equal(capabilities.read_only_available, true);
  assert(f.calls.every((call) => call.method === "GET"));
});

test("unchecking the default write choice issues a read-only grant without a domain", async (t) => {
  const f = await fixture(t, undefined, true),
    client = await f.register("Read-only choice");
  const { tokens } = await defaultConsent(f, client, false);
  assert.equal(tokens.scope, SCOPE);
  const ai = await f.connect(tokens.access_token);
  assert.equal((await ai.listTools()).tools.length, 6);
  const denied = await f.request("/api/v1/plans", {
    method: "POST",
    headers: { authorization: "Bearer " + tokens.access_token, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(denied.status, 403);
  assert(f.calls.every((call) => call.method === "GET"));
});

test("read-only client registration and operator opt-out keep unscoped consent read-only", async (t) => {
  for (const enabled of [true, false]) {
    const f = await fixture(t, undefined, enabled),
      client = await f.register("Read-only client", enabled ? { scope: SCOPE } : {});
    const { consent, tokens } = await defaultConsent(f, client, false);
    assert(!consent.includes('name="enable_dns_test"'));
    assert.equal(tokens.scope, SCOPE);
    const ai = await f.connect(tokens.access_token);
    assert.equal((await ai.listTools()).tools.length, 6);
    assert(f.calls.every((call) => call.method === "GET"));
  }
});

test("operator opt-out narrows an earlier write-capable registration without upgrading grants", async (t) => {
  const f = await fixture(t, undefined, true),
    client = await f.register("Earlier write-capable client"),
    off = new HostedOAuth(f.store, f.origin, false);
  assert.equal(client.scope, SCOPE + " " + WRITE_SCOPE);
  let location;
  const params = { scopes: [], redirectUri: client.redirect_uris[0], codeChallenge: challenge };
  await off.authorize(client, params, {
    cookie() {},
    redirect(_status, target) {
      location = target;
    },
  });
  const request = new URL(location, f.origin).searchParams.get("request");
  assert.deepEqual(f.store.get("pending", fingerprint(request)).scopes, [SCOPE]);
  await assert.rejects(
    off.authorize(client, { ...params, scopes: [SCOPE, WRITE_SCOPE] }, {}),
    /Requested scope is unavailable/,
  );
  assert.equal(f.store.list("grant").length, 0);
  assert.equal(f.calls.length, 0);
});

test("hosted write consent binds one test TXT name, separates browser approval and executes once", async (t) => {
  const f = await fixture(t, undefined, true);
  const client = await f.register("Write test", { scope: SCOPE + " " + WRITE_SCOPE });
  const consent = await f.consent(client, A, 10, {
    enable_dns_test: "yes",
    test_zone: "example-10.com",
  });
  const token = await (await f.exchange(client, consent.code)).json();
  assert(token.scope.includes(WRITE_SCOPE));
  const headers = {
    authorization: "Bearer " + token.access_token,
    "content-type": "application/json",
  };
  const api = (path, data) =>
    f.request(
      "/api/v1/" + path,
      data === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(data) },
    );
  const args = {
    account_id: 10,
    zone: "example-10.com",
    source: "_infomaniak-ai-test",
    type: "TXT",
    target: "disposable hosted test",
    ttl: 300,
  };
  const r = await api("plans", { operation: "dns.record.create", arguments: args });
  assert.equal(r.status, 201, await r.clone().text());
  const { plan, approval_url } = await r.json();
  assert.equal(approval_url, "/write-reviews/" + plan.id);
  assert.equal(f.calls.filter((c) => c.method !== "GET").length, 0);
  assert.equal((await api("plans/" + plan.id + "/execute", { plan_hash: plan.hash })).status, 409);
  assert.equal((await f.request(approval_url, { headers })).status, 400);
  const review = await (
    await f.request(approval_url, { headers: { cookie: consent.manage } })
  ).text();
  assert(review.includes("disposable hosted test"));
  const csrf = field(review, "csrf");
  const rejected = await f.form(
    approval_url,
    { csrf, plan_hash: plan.hash, ack: "APPROVE", decision: "approve" },
    "",
  );
  assert.equal(rejected.status, 400);
  assert.equal(
    (
      await f.form(
        approval_url,
        { csrf, plan_hash: plan.hash, ack: "APPROVE", decision: "approve" },
        consent.manage,
      )
    ).status,
    303,
  );
  const applied = await api("plans/" + plan.id + "/execute", { plan_hash: plan.hash });
  assert.equal(applied.status, 200, await applied.clone().text());
  assert.equal((await applied.json()).plan.state, "verified");
  assert.equal((await api("plans/" + plan.id + "/execute", { plan_hash: plan.hash })).status, 409);
  assert.equal(f.calls.filter((c) => c.method !== "GET").length, 1);
  for (const arguments_ of [
    { ...args, account_id: 20 },
    { ...args, zone: "example-20.com" },
    { ...args, source: "www" },
    { ...args, type: "A" },
  ])
    assert.equal(
      (await api("plans", { operation: "dns.record.create", arguments: arguments_ })).status,
      403,
    );
  const sdk = await f.connect(token.access_token);
  assert.equal((await sdk.listTools()).tools.length, 10);
  const status = await sdk.callTool({ name: "infomaniak_status", arguments: {} });
  assert.equal(status.structuredContent.writes_enabled, true);
  const search = await sdk.callTool({
    name: "infomaniak_search",
    arguments: { query: "dns create", limit: 3 },
  });
  const described = search.structuredContent.operations.find(
    (o) => o.operation === "dns.record.create",
  );
  assert.equal(described.input_schema.properties.type.const, "TXT");
  assert.equal(described.input_schema.properties.source.const, "_infomaniak-ai-test");
  // Neither the plan values nor credential appear unencrypted on disk.
  const files = await readdir(f.directory);
  for (const file of files)
    if (/sqlite/.test(file)) {
      const bytes = await readFile(join(f.directory, file));
      for (const secret of [A, "example-10.com", "disposable hosted test"])
        assert(!bytes.includes(Buffer.from(secret)));
    }
});

test("hosted read-only tokens cannot expand to write scope or use the shared write API", async (t) => {
  const f = await fixture(t, undefined, true),
    client = await f.register();
  const consent = await f.consent(client),
    token = await (await f.exchange(client, consent.code)).json();
  assert.equal(token.scope, SCOPE);
  const readHeaders = {
    authorization: "Bearer " + token.access_token,
    "content-type": "application/json",
  };
  const read = await f.request("/api/v1/reads", {
    method: "POST",
    headers: readHeaders,
    body: JSON.stringify({ operation: "accounts.list", arguments: {} }),
  });
  assert.equal(read.status, 200);
  assert.deepEqual(
    (await read.json()).data.map((a) => a.id),
    [10],
  );
  const denied = await f.request("/api/v1/plans", {
    method: "POST",
    headers: { authorization: "Bearer " + token.access_token, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(denied.status, 403);
  const expanded = await f.form("/token", {
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: token.refresh_token,
    scope: SCOPE + " " + WRITE_SCOPE,
    resource: new URL("/mcp", f.origin).href,
  });
  assert.equal(expanded.status, 400);
  assert.equal(f.calls.filter((c) => c.method !== "GET").length, 0);
});

test("hosted write review rejects another browser and scope downgrade removes write access", async (t) => {
  const f = await fixture(t, undefined, true),
    client = await f.register("Scoped DNS", { scope: SCOPE + " " + WRITE_SCOPE });
  const a = await f.consent(client, A, 10, { enable_dns_test: "yes", test_zone: "example-10.com" }),
    b = await f.consent(client, B, 20, { enable_dns_test: "yes", test_zone: "example-20.com" });
  const token = await (await f.exchange(client, a.code)).json(),
    other = await (await f.exchange(client, b.code)).json();
  const headers = {
    authorization: "Bearer " + token.access_token,
    "content-type": "application/json",
  };
  const p = await (
    await f.request("/api/v1/plans", {
      method: "POST",
      headers,
      body: JSON.stringify({
        operation: "dns.record.create",
        arguments: {
          account_id: 10,
          zone: "example-10.com",
          source: "_infomaniak-ai-test",
          type: "TXT",
          target: "review",
          ttl: 300,
        },
      }),
    })
  ).json();
  assert.equal(
    (await f.request("/write-reviews/" + p.plan.id, { headers: { cookie: b.manage } })).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/v1/plans/" + p.plan.id, {
        headers: { authorization: "Bearer " + other.access_token },
      })
    ).status,
    404,
  );
  const downgraded = await f.form("/token", {
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: token.refresh_token,
    scope: SCOPE,
    resource: new URL("/mcp", f.origin).href,
  });
  assert.equal(downgraded.status, 200);
  assert.equal((await downgraded.json()).scope, SCOPE);
  assert.equal((await f.request("/api/v1/plans/" + p.plan.id, { headers })).status, 403);
  assert.equal(f.calls.filter((c) => c.method !== "GET").length, 0);
});
