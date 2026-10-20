import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request as rawRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createRemote } from "../dist/remote.js";
import { digest } from "../dist/access.js";
import { fixture, createArgs, CLIENT_KEY, HUMAN_KEY, PROVIDER_KEY } from "./fixtures/api.mjs";

async function remoteFixture(t, customize) {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const base = "http://127.0.0.1:" + port;
  const f = await fixture(
    t,
    { remote: { host: "127.0.0.1", port, public_origin: base } },
    customize,
  );
  const server = createRemote(f.app);
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const request = (path, options = {}) =>
    fetch(base + path, { ...options, redirect: "manual", headers: { ...options.headers } });
  const login = async (key = HUMAN_KEY, principal = "owner") => {
    const res = await request("/approvals/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
      body: new URLSearchParams({ principal, key }),
    });
    return { res, cookie: res.headers.get("set-cookie")?.split(";")[0] };
  };
  return { ...f, request, login, base };
}
test("remote MCP rejects anonymous, provider and approval credentials, foreign hosts and origins", async (t) => {
  const f = await remoteFixture(t);
  for (const key of [undefined, PROVIDER_KEY, HUMAN_KEY]) {
    const response = await f.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: "Bearer " + key } : {}),
      },
      body: "{}",
    });
    assert.equal(response.status, 401);
  }
  const invalidHost = await new Promise((resolve) => {
    const r = rawRequest(f.base + "/healthz", { headers: { host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    r.end();
  });
  assert.equal(invalidHost, 403);
  assert.equal(
    (await f.request("/healthz", { headers: { origin: "https://evil.example" } })).status,
    403,
  );
  assert.equal((await f.request("/mcp?token=" + CLIENT_KEY)).status, 400);
  assert.equal(f.api.calls.length, 0);
});
test("a standard SDK client discovers tools and executes only independently approved plans over HTTP", async (t) => {
  const f = await remoteFixture(t);
  const transport = new StreamableHTTPClientTransport(new URL(f.base + "/mcp"), {
    requestInit: { headers: { authorization: "Bearer " + CLIENT_KEY } },
  });
  const client = new Client({ name: "fixture-remote-client", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 8);
  assert(!tools.tools.some((t) => t.name.includes("approve")));
  const result = await client.callTool({
    name: "infomaniak_plan",
    arguments: { operation: "dns.record.create", arguments: createArgs },
  });
  assert(!result.isError);
  const p = result.structuredContent.plan;
  const denied = await client.callTool({
    name: "infomaniak_execute",
    arguments: { plan_id: p.id, plan_hash: p.hash },
  });
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.content[0].text).code, "approval_required");
  const { res, cookie } = await f.login();
  assert.equal(res.status, 303);
  assert(res.headers.get("set-cookie").includes("HttpOnly"));
  const detail = await f.request("/approvals/" + p.id, { headers: { cookie } });
  const page = await detail.text(),
    csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1];
  assert(csrf);
  assert(page.includes("DNS changes can affect"));
  const decision = await f.request("/approvals/" + p.id, {
    method: "POST",
    headers: { cookie, origin: f.base, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, plan_hash: p.hash, ack: "APPROVE" }),
  });
  assert.equal(decision.status, 303);
  const applied = await client.callTool({
    name: "infomaniak_execute",
    arguments: { plan_id: p.id, plan_hash: p.hash },
  });
  assert.equal(applied.structuredContent.plan.state, "verified");
  assert.equal(f.api.calls.filter((r) => r.method === "POST").length, 1);
});
test("approval login and decisions reject MCP keys, CSRF, missing Origin, wrong hashes and acknowledgement", async (t) => {
  const f = await remoteFixture(t),
    p = await f.engine.plan("dns.record.create", createArgs);
  assert.equal((await f.login(CLIENT_KEY)).res.status, 401);
  assert.equal(
    (await f.request("/approvals/" + p.id, { headers: { authorization: "Bearer " + CLIENT_KEY } }))
      .status,
    303,
  );
  const { cookie } = await f.login();
  const page = await (await f.request("/approvals/" + p.id, { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
  for (const fields of [
    { csrf: "wrong", plan_hash: p.hash, ack: "APPROVE" },
    { csrf, plan_hash: p.hash, ack: "yes" },
    { csrf, plan_hash: "0".repeat(64), ack: "APPROVE" },
  ]) {
    const res = await f.request("/approvals/" + p.id, {
      method: "POST",
      headers: { cookie, origin: f.base, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
    assert([400, 403].includes(res.status));
  }
  const noOrigin = await f.request("/approvals/" + p.id, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, plan_hash: p.hash, ack: "APPROVE" }),
  });
  assert.equal(noOrigin.status, 403);
  assert.equal(f.engine.status(p.id).state, "planned");
});
test("provider text is escaped in approval pages and cannot execute scripts or submit forms", async (t) => {
  const f = await remoteFixture(t);
  const p = await f.engine.plan("dns.record.create", {
    ...createArgs,
    type: "TXT",
    target: '<script>alert("unsafe")</script>',
  });
  const { cookie } = await f.login();
  const res = await f.request("/approvals/" + p.id, { headers: { cookie } });
  const html = await res.text();
  assert(!html.includes("<script>"));
  assert(html.includes("&lt;script&gt;"));
  assert(res.headers.get("content-security-policy").includes("default-src 'none'"));
  assert(res.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
});
test("request size and content-type limits reject inputs without a provider mutation", async (t) => {
  const f = await remoteFixture(t);
  const headers = { authorization: "Bearer " + CLIENT_KEY, "content-type": "application/json" };
  assert.equal(
    (
      await f.request("/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({ huge: "x".repeat(65_000) }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/mcp", {
        method: "POST",
        headers: { authorization: "Bearer " + CLIENT_KEY },
        body: "{}",
      })
    ).status,
    415,
  );
  assert.equal(f.api.calls.length, 0);
});

test("remote tenants cannot read, approve or execute another tenant's plan", async (t) => {
  const otherClient = "fixture-other-client-".repeat(4),
    otherHuman = "fixture-other-human-".repeat(4);
  const f = await remoteFixture(t, (cfg) => {
    const p = structuredClone(cfg.principals[0]);
    p.id = "other";
    p.credential_env = "FIXTURE_PROVIDER_2";
    p.access_token_sha256 = digest(otherClient);
    p.approval_token_sha256 = digest(otherHuman);
    p.accounts = [20];
    p.resources = {
      zones: { "other.example": { account_id: 20, disposable: true, writable: true } },
      dns_names: {},
      mail_hostings: {},
      mailboxes: {},
      vps: {},
    };
    cfg.principals.push(p);
  });
  const ownerPlan = await f.engine.plan("dns.record.create", createArgs);
  const client = new Client({ name: "second-tenant", version: "1" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(f.base + "/mcp"), {
      requestInit: { headers: { authorization: "Bearer " + otherClient } },
    }),
  );
  const status = await client.callTool({ name: "infomaniak_status", arguments: {} });
  assert.deepEqual(status.structuredContent.accounts, [20]);
  const reads = await client.callTool({
    name: "infomaniak_operation",
    arguments: { plan_id: ownerPlan.id },
  });
  assert.equal(reads.isError, true);
  assert.equal(JSON.parse(reads.content[0].text).code, "plan_not_found");
  const denied = await client.callTool({
    name: "infomaniak_plan",
    arguments: { operation: "dns.record.create", arguments: createArgs },
  });
  assert.equal(JSON.parse(denied.content[0].text).code, "access_denied");
  const otherPlan = await f.app.engines
    .get("other")
    .plan("dns.record.create", { ...createArgs, account_id: 20, zone: "other.example" });
  const { cookie } = await f.login(otherHuman, "other");
  const page = await (
    await f.request("/approvals/" + otherPlan.id, { headers: { cookie } })
  ).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
  const result = await f.request("/approvals/" + ownerPlan.id, {
    method: "POST",
    headers: { cookie, origin: f.base, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, plan_hash: ownerPlan.hash, ack: "APPROVE" }),
  });
  assert.equal(result.status, 400);
  assert.equal(f.engine.status(ownerPlan.id).state, "planned");
  assert.equal(f.api.calls.filter((r) => r.method !== "GET").length, 0);
});

test("human approval logout invalidates its session without changing provider state", async (t) => {
  const f = await remoteFixture(t),
    { cookie } = await f.login();
  const page = await (await f.request("/approvals", { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
  const logout = await f.request("/approvals/logout", {
    method: "POST",
    headers: { cookie, origin: f.base, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf }),
  });
  assert.equal(logout.status, 303);
  assert(logout.headers.get("set-cookie").includes("Max-Age=0"));
  assert.equal((await f.request("/approvals", { headers: { cookie } })).status, 303);
  assert.equal(f.api.calls.length, 0);
});
