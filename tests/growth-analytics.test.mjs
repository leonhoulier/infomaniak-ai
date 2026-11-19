import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HostedStore } from "../dist/hosted-store.js";
import { createHostedAnalytics, isoWeek, parseExcludedAccounts } from "../dist/hosted-analytics.js";
import { hostedFixture } from "./fixtures/hosted.mjs";

// Synthetic identifiers only. This value must never reach captured analytics.
const OPERATOR_ACCOUNT = 987654321;
const env = { POSTHOG_PROJECT_TOKEN: "phc_fixture", POSTHOG_HOST: "https://eu.i.posthog.com" };

async function analyticsStore(t, now = () => Date.now()) {
  const directory = await mkdtemp(join(tmpdir(), "ik-growth-analytics-"));
  const key = randomBytes(32);
  let store = new HostedStore(directory, key, now);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    reopen() {
      try {
        store.close();
      } catch {
        /* Already closed by the test. */
      }
      store = new HostedStore(directory, key, now);
      return store;
    },
  };
}
function fakeClient(captured) {
  return () => ({
    on() {},
    capture: (event) => captured.push(event),
    shutdown: async () => {},
  });
}

test("ISO week labels follow ISO 8601 at year boundaries", () => {
  assert.equal(isoWeek(Date.parse("2026-11-19T12:00:00Z")).label, "2026-W47");
  assert.equal(isoWeek(Date.parse("2027-01-01T00:00:00Z")).label, "2026-W53");
  assert.equal(isoWeek(Date.parse("2024-12-30T00:00:00Z")).label, "2025-W01");
  assert.equal(
    new Date(isoWeek(Date.parse("2026-11-22T23:59:59Z")).start).toISOString(),
    "2026-11-16T00:00:00.000Z",
  );
});

test("operator exclusion is parsed strictly; an invalid list disables analytics", async (t) => {
  assert.deepEqual([...parseExcludedAccounts(" 12, 34 ")], [12, 34]);
  assert.deepEqual([...parseExcludedAccounts(undefined)], []);
  for (const bad of ["abc", "12,,34", "-1", "0", "1.5", "99999999999999999999"])
    assert.equal(parseExcludedAccounts(bad), undefined, bad);
  const s = await analyticsStore(t);
  let created = false;
  const original = console.error;
  console.error = () => {};
  try {
    const disabled = createHostedAnalytics(
      s.store,
      { ...env, INFOMANIAK_ANALYTICS_EXCLUDED_ACCOUNTS: "not-an-id" },
      () => {
        created = true;
      },
    );
    assert.equal(disabled, undefined);
    assert.equal(created, false);
  } finally {
    console.error = original;
  }
  const analytics = createHostedAnalytics(
    s.store,
    { ...env, INFOMANIAK_ANALYTICS_EXCLUDED_ACCOUNTS: String(OPERATOR_ACCOUNT) },
    fakeClient([]),
  );
  assert.equal(analytics.excludes([10]), false);
  assert.equal(analytics.excludes([10, OPERATOR_ACCOUNT]), true);
});

test("details are allowlisted and once-events survive restarts without duplicates", async (t) => {
  let now = Date.parse("2026-11-19T12:00:00Z");
  const s = await analyticsStore(t, () => now),
    captured = [];
  let analytics = createHostedAnalytics(s.store, env, fakeClient(captured));
  analytics.record("connection_approved", undefined, {
    access: "resources",
    operation: "private.customer.operation",
    kind: "private",
    lang: "de",
  });
  assert.deepEqual(captured[0].properties, {
    $process_person_profile: false,
    service: "infomaniak-mcp",
    access: "resources",
    operation: "other",
  });
  analytics.once("connection_activated", "grant-a", now + 3_600_000, { operation: "dns.audit" });
  analytics.once("connection_activated", "grant-a", now + 3_600_000, { operation: "dns.audit" });
  analytics = createHostedAnalytics(s.reopen(), env, fakeClient(captured));
  analytics.once("connection_activated", "grant-a", now + 3_600_000, { operation: "dns.audit" });
  analytics.once("connection_activated", "grant-b", now + 3_600_000);
  assert.deepEqual(
    captured.map((e) => [e.event, e.properties.operation]),
    [
      ["connection_approved", "other"],
      ["connection_activated", "dns.audit"],
      ["connection_activated", undefined],
    ],
  );
  // Subject identifiers are one-way in the store and never sent.
  assert(!JSON.stringify(captured).includes("grant-"));
  assert(!s.store.list("analytics-once").some((r) => r.id.includes("grant-")));
  // An event dropped by the daily cap is not marked as sent, so it can still be counted once.
  for (let i = 0; i < 1000; i++) analytics.record("homepage_viewed");
  const before = captured.length;
  analytics.once("connection_activated", "grant-c", now + 3 * 86_400_000);
  assert.equal(captured.length, before);
  now += 86_400_000;
  analytics.once("connection_activated", "grant-c", now + 3 * 86_400_000);
  analytics.once("connection_activated", "grant-c", now + 3 * 86_400_000);
  assert.equal(captured.length, before + 1);
});

test("weekly active connections are sent once per closed week, deduplicated and deleted", async (t) => {
  let now = Date.parse("2026-11-17T09:00:00Z"); // Tuesday of 2026-W47
  const s = await analyticsStore(t, () => now),
    captured = [];
  let analytics = createHostedAnalytics(s.store, env, fakeClient(captured));
  const weekly = () => captured.filter((e) => e.event === "weekly_active_connections");
  analytics.active("connection-a");
  analytics.active("connection-a");
  analytics.active("connection-b");
  analytics.record("homepage_viewed");
  assert.equal(weekly().length, 0, "an open week is never reported");
  // Stored rows carry the week and a one-way identifier, never the connection ID.
  assert.equal(s.store.list("analytics-active").length, 2);
  assert(s.store.list("analytics-active").every((r) => /^2026-W47:[a-f0-9]{64}$/.test(r.id)));
  // The daily cap cannot drop the weekly aggregate.
  for (let i = 0; i < 1100; i++) analytics.record("homepage_viewed");
  now = Date.parse("2026-11-24T08:00:00Z"); // 2026-W48
  analytics = createHostedAnalytics(s.reopen(), env, fakeClient(captured));
  analytics.active("connection-a");
  analytics.record("homepage_viewed");
  analytics.record("homepage_viewed");
  assert.equal(weekly().length, 1);
  assert.deepEqual(weekly()[0].properties, {
    $process_person_profile: false,
    service: "infomaniak-mcp",
    week: "2026-W47",
    connections: 2,
    capped: false,
  });
  assert(s.store.list("analytics-active").every((r) => r.id.startsWith("2026-W48:")));
  assert.deepEqual(
    s.store.list("analytics-week").map((r) => r.id),
    ["2026-W48"],
  );
  // A restart in the same week does not resend the closed total.
  analytics = createHostedAnalytics(s.reopen(), env, fakeClient(captured));
  analytics.record("homepage_viewed");
  assert.equal(weekly().length, 1);
  // A week nobody reports within its retention expires instead of being resurrected.
  now = Date.parse("2026-12-30T08:00:00Z");
  analytics = createHostedAnalytics(s.reopen(), env, fakeClient(captured));
  analytics.record("homepage_viewed");
  assert.equal(weekly().length, 1);
  s.store.prune();
  assert.equal(s.store.list("analytics-active").length, 0);
  assert(!JSON.stringify(captured).includes("connection-"));
});

test("analytics storage failures fail open", async (t) => {
  const s = await analyticsStore(t),
    analytics = createHostedAnalytics(s.store, env, fakeClient([]));
  s.store.close();
  assert.doesNotThrow(() => analytics.record("homepage_viewed"));
  assert.doesNotThrow(() => analytics.once("connection_started", "x", Date.now() + 1000));
  assert.doesNotThrow(() => analytics.active("x"));
  s.reopen();
});

test("activity and deduplication retention are bounded without extending subject expiry", async (t) => {
  let now = Date.parse("2026-11-17T09:00:00Z");
  const s = await analyticsStore(t, () => now),
    captured = [],
    analytics = createHostedAnalytics(s.store, env, fakeClient(captured)),
    day = 86_400_000;
  for (const expiry of [now - 1, now, Infinity, NaN])
    analytics.once("connection_started", "invalid", expiry);
  assert.equal(captured.length, 0);
  analytics.once("connection_started", "short", now + 10);
  analytics.once("connection_started", "long", now + 100 * day);
  now += 11;
  s.store.prune();
  assert.equal(
    s.store.list("analytics-once").length,
    1,
    "short-lived markers do not outlive the subject",
  );
  s.store.put("analytics-week", "2026-W47", { count: 9999, capped: false }, now + 21 * day);
  analytics.active("at-limit");
  analytics.active("over-limit");
  assert.equal(s.store.list("analytics-active").length, 1);
  now += 7 * day;
  analytics.record("homepage_viewed");
  const total = captured.find((e) => e.event === "weekly_active_connections");
  assert.equal(total.properties.connections, 10000);
  assert.equal(total.properties.capped, true);
  now += 26 * day;
  s.store.prune();
  assert.equal(s.store.list("analytics-once").length, 0);
  assert.equal(s.store.list("analytics-active").length, 0);
  assert.equal(s.store.list("analytics-week").length, 0);
});

async function connect(f, access, headers = {}) {
  const client = new Client({ name: "growth-analytics-fixture", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", f.origin), {
      requestInit: { headers: { authorization: "Bearer " + access, ...headers } },
    }),
  );
  return client;
}
async function consentFlow(f, { dnsOnly = true, token = "fixture-consent-provider-token" } = {}) {
  const verifier = randomBytes(32).toString("base64url"),
    challenge = createHash("sha256").update(verifier).digest("base64url");
  // No scope requested: what a one-line `claude mcp add --transport http` client sends.
  const client = await (
    await f.json("/register", {
      client_name: "Growth fixture",
      redirect_uris: ["https://ai.example/callback"],
      token_endpoint_auth_method: "none",
    })
  ).json();
  const start = await f.request(
    "/authorize?" +
      new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: f.origin.origin + "/mcp",
      }),
  );
  const cookie = start.headers.getSetCookie()[0].split(";")[0],
    path = start.headers.get("location"),
    request = new URL(path, f.origin).searchParams.get("request");
  const form = (path, data) =>
    f.request(path, {
      method: "POST",
      headers: {
        origin: f.origin.origin,
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(data),
    });
  const first = await (await f.request(path, { headers: { cookie } })).text();
  await f.request(path, { headers: { cookie } }); // A reload is not a second start.
  let csrf = /name="csrf" value="([^"]+)"/.exec(first)[1];
  const rejected = await form("/connect/token", { request, csrf, provider_token: "short" });
  assert.equal(rejected.status, 400);
  csrf = /name="csrf" value="([^"]+)"/.exec(await rejected.text())[1];
  const verified = await form("/connect/token", { request, csrf, provider_token: token });
  assert.equal(verified.status, 200);
  const html = await verified.text();
  assert.match(html, /Domains for DNS management/);
  const finish = await form("/connect/finish", {
    request,
    csrf: /name="csrf" value="([^"]+)"/.exec(html)[1],
    account: "10",
    decision: "allow",
    enable_resources: "yes",
    dns_zones: "example.com",
    ...(dnsOnly ? {} : { mailbox_addresses: "hello@example.com" }),
  });
  assert.equal(finish.status, 303);
  const callback = new URL(finish.headers.get("location"));
  const tokens = await (
    await f.request("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "authorization_code",
        code: callback.searchParams.get("code"),
        code_verifier: verifier,
        redirect_uri: client.redirect_uris[0],
        resource: f.origin.origin + "/mcp",
      }),
    })
  ).json();
  const manage = finish.headers
    .getSetCookie()
    .find((c) => c.startsWith("ik_manage="))
    .split(";")[0];
  return { access: tokens.access_token, manage };
}

test("the first-task path counts setup, activation, verified writes and weekly activity without identifiers", async (t) => {
  const s = await analyticsStore(t),
    captured = [];
  const analytics = createHostedAnalytics(s.store, env, fakeClient(captured));
  const f = await hostedFixture(t, { analytics });
  const { access, manage } = await consentFlow(f);
  const client = await connect(f, access);
  t.after(() => client.close());
  const read = (operation) =>
    client.callTool({
      name: "infomaniak_read",
      arguments: { operation, arguments: { account_id: 10, zone: "example.com" } },
    });
  const audit = await read("dns.audit");
  assert(!audit.isError, JSON.stringify(audit));
  assert.deepEqual(
    audit.structuredContent.data.findings.map((finding) => finding.code),
    ["spf_missing", "dmarc_missing", "mx_missing"],
  );
  assert(!(await read("dns.records.list")).isError);
  const planned = await client.callTool({
    name: "infomaniak_plan",
    arguments: {
      operation: "dns.record.create",
      arguments: {
        account_id: 10,
        zone: "example.com",
        source: "_growth-test",
        type: "TXT",
        target: "fixture",
        ttl: 300,
      },
    },
  });
  const plan = planned.structuredContent.plan;
  const review = await f.request("/write-reviews/" + plan.id, { headers: { cookie: manage } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(await review.text())[1];
  const approve = await f.request("/write-reviews/" + plan.id, {
    method: "POST",
    headers: {
      origin: f.origin.origin,
      cookie: manage,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ csrf, plan_hash: plan.hash, ack: "APPROVE", decision: "approve" }),
  });
  assert.equal(approve.status, 303);
  const executed = await client.callTool({
    name: "infomaniak_execute",
    arguments: { plan_id: plan.id, plan_hash: plan.hash },
  });
  assert.equal(executed.structuredContent.plan.state, "verified", JSON.stringify(executed));
  await client.callTool({ name: "infomaniak_operation", arguments: { plan_id: plan.id } });
  await client.callTool({
    name: "infomaniak_operation",
    arguments: { plan_id: plan.id, refresh: true },
  });
  const names = captured.map((e) => e.event);
  const countOf = (name) => names.filter((n) => n === name).length;
  assert.equal(countOf("connection_started"), 1);
  assert.equal(countOf("setup_token_rejected"), 1);
  assert.equal(countOf("setup_token_accepted"), 1);
  assert.equal(countOf("connection_approved"), 1);
  assert.equal(
    captured.find((e) => e.event === "connection_approved").properties.access,
    "resources",
  );
  assert.equal(countOf("connection_activated"), 1);
  assert.equal(
    captured.find((e) => e.event === "connection_activated").properties.operation,
    "dns.audit",
  );
  assert.equal(countOf("write_verified"), 1);
  assert.equal(captured.find((e) => e.event === "write_verified").properties.kind, "dns");
  assert.equal(countOf("write_not_verified"), 0);
  assert(countOf("tool_completed") >= 6);
  assert.equal(s.store.list("analytics-active").length, 1, "one connection active this week");
  const text = JSON.stringify(captured);
  for (const secret of [
    "fixture-consent-provider-token",
    access,
    "example.com",
    "_growth-test",
    plan.id,
    plan.hash,
    '"10"',
  ])
    assert(!text.includes(secret), secret);
  for (const event of captured)
    assert.deepEqual(
      Object.keys(event.properties).filter(
        (k) =>
          ![
            "$process_person_profile",
            "service",
            "tool",
            "access",
            "operation",
            "kind",
            "state",
          ].includes(k),
      ),
      [],
    );
  assert.equal(new Set(captured.map((e) => e.distinctId)).size, captured.length);
});

test("operator accounts and GPC/DNT requests contribute nothing, including weekly activity", async (t) => {
  const s = await analyticsStore(t),
    captured = [];
  const analytics = createHostedAnalytics(
    s.store,
    { ...env, INFOMANIAK_ANALYTICS_EXCLUDED_ACCOUNTS: "10" },
    fakeClient(captured),
  );
  const f = await hostedFixture(t, { analytics });
  const { access } = await consentFlow(f);
  const client = await connect(f, access);
  t.after(() => client.close());
  await client.callTool({
    name: "infomaniak_read",
    arguments: { operation: "dns.audit", arguments: { account_id: 10, zone: "example.com" } },
  });
  // Only pre-account steps remain; the operator's browser can suppress them with GPC.
  assert.deepEqual(
    captured.map((e) => e.event),
    ["connection_started", "setup_token_rejected"],
  );
  assert.equal(s.store.list("analytics-active").length, 0);
  assert(!JSON.stringify(captured).includes(String(OPERATOR_ACCOUNT)));

  const s2 = await analyticsStore(t),
    captured2 = [];
  const f2 = await hostedFixture(t, {
    analytics: createHostedAnalytics(s2.store, env, fakeClient(captured2)),
  });
  for (const headers of [{ dnt: "1" }, { "sec-gpc": "1" }]) {
    const privateClient = await connect(f2, f2.access, headers);
    await privateClient.callTool({
      name: "infomaniak_read",
      arguments: { operation: "accounts.list", arguments: {} },
    });
    await privateClient.close();
    assert.equal((await f2.request("/", { headers })).status, 200);
  }
  assert.deepEqual(captured2, []);
  assert.equal(s2.store.list("analytics-active").length, 0);
  assert.equal(s2.store.list("analytics-once").length, 0);
});

test("an analytics implementation that throws cannot change consent or tool results", async (t) => {
  const boom = () => {
    throw new Error("analytics unavailable");
  };
  const f = await hostedFixture(t, {
    analytics: { record: boom, once: boom, excludes: boom, active: boom, shutdown: async () => {} },
  });
  const { access } = await consentFlow(f);
  const client = await connect(f, access);
  t.after(() => client.close());
  const result = await client.callTool({
    name: "infomaniak_read",
    arguments: { operation: "dns.audit", arguments: { account_id: 10, zone: "example.com" } },
  });
  assert(!result.isError, JSON.stringify(result));
  assert.equal((await f.request("/")).status, 200);
});
