import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { API_TOOLS, DOCUMENTATION_TOOLS, createProtocol } from "../dist/protocol.js";
import { createHostedAnalytics } from "../dist/hosted-analytics.js";
import { PluginError } from "../dist/errors.js";
import { hostedFixture } from "./fixtures/hosted.mjs";

test("every registered MCP tool exports one anonymous outcome, including docs and failures", async (t) => {
  const captured = [],
    budget = new Map();
  const analytics = createHostedAnalytics(
    {
      now: () => Date.now(),
      get: (_, key) => budget.get(key),
      put: (_, key, value) => budget.set(key, value),
    },
    { POSTHOG_PROJECT_TOKEN: "phc_fixture", POSTHOG_HOST: "https://eu.i.posthog.com" },
    () => ({ on() {}, capture: (event) => captured.push(event), shutdown: async () => {} }),
  );
  let fail = false;
  const result = () => {
    if (fail) throw new PluginError("fixture_failure", "private error detail");
    return { private_result: "must not enter telemetry" };
  };
  const server = createProtocol(
    async () => result(),
    true,
    false,
    { dispatch: async (name) => (name.startsWith("infomaniak_docs_") ? result() : undefined) },
    undefined,
    undefined,
    (name, failed) => analytics.record(failed ? "tool_failed" : "tool_completed", name),
  );
  const client = new Client({ name: "outcome-fixture", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  for (const tool of [...API_TOOLS, ...DOCUMENTATION_TOOLS]) {
    for (fail of [false, true]) {
      const before = captured.length;
      const response = await client.callTool({
        name: tool.name,
        arguments: { private_argument: "excluded" },
      });
      assert.equal(Boolean(response.isError), fail);
      assert.equal(captured.length, before + 1);
      assert.equal(captured.at(-1).event, fail ? "tool_failed" : "tool_completed");
      assert.deepEqual(captured.at(-1).properties, {
        $process_person_profile: false,
        service: "infomaniak-mcp",
        tool: tool.name,
      });
    }
  }
  const before = captured.length;
  await client.callTool({ name: "unknown-private-tool-name", arguments: {} });
  assert.equal(captured.length, before);
  assert.equal(new Set(captured.map((event) => event.distinctId)).size, captured.length);
  assert(!JSON.stringify(captured).includes("private"));
});

test("a failing outcome observer cannot change success, errors or slot release", async (t) => {
  let releases = 0;
  const server = createProtocol(
    async (_, args) => {
      if (args.fail) throw new PluginError("expected", "fixture");
      return { ok: true };
    },
    true,
    false,
    { dispatch: async () => undefined },
    undefined,
    () => () => {
      releases++;
    },
    () => {
      throw new Error("analytics unavailable");
    },
  );
  const client = new Client({ name: "outcome-fixture", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  assert.equal(
    (await client.callTool({ name: "infomaniak_status", arguments: {} })).structuredContent.ok,
    true,
  );
  assert.equal(
    (await client.callTool({ name: "infomaniak_status", arguments: { fail: true } })).isError,
    true,
  );
  assert.equal(releases, 2);
});

test("hosted resource and deployment branches count once and respect GPC/DNT", async (t) => {
  const events = [];
  const f = await hostedFixture(t, {
    analytics: { record: (...event) => events.push(event), shutdown: async () => {} },
  });
  async function connect(headers = {}) {
    const client = new Client({ name: "outcome-http-fixture", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", f.origin), {
        requestInit: { headers: { authorization: "Bearer " + f.access, ...headers } },
      }),
    );
    t.after(() => client.close());
    return client;
  }
  const client = await connect();
  const call = async (name, args, failed = false) => {
    const before = events.length;
    const r = await client.callTool({ name, arguments: args });
    assert.equal(Boolean(r.isError), failed, JSON.stringify(r));
    assert.deepEqual(events.slice(before), [[failed ? "tool_failed" : "tool_completed", name]]);
    return r.structuredContent;
  };
  await call("infomaniak_status", {});
  const { plan } = await call("infomaniak_plan", {
    operation: "dns.record.create",
    arguments: {
      account_id: 10,
      zone: "example.com",
      source: "_analytics-test",
      type: "TXT",
      target: "fixture",
      ttl: 300,
    },
  });
  await call("infomaniak_execute", { plan_id: plan.id, plan_hash: plan.hash }, true);
  await call("infomaniak_operation", { plan_id: plan.id });
  await call("infomaniak_cancel", { plan_id: plan.id });
  await call(
    "infomaniak_read",
    {
      operation: "deployment.app.get",
      arguments: { account_id: 10, runner_id: "missing", app: "fixture" },
    },
    true,
  );
  await call("infomaniak_docs_read", { url: "https://example.invalid/private" }, true);
  for (const headers of [{ dnt: "1" }, { "sec-gpc": "1" }]) {
    const privateClient = await connect(headers);
    const before = events.length;
    await privateClient.callTool({ name: "infomaniak_status", arguments: {} });
    await privateClient.callTool({ name: "infomaniak_plan", arguments: {} });
    assert.equal(events.length, before);
  }
  assert.equal(f.api.calls.filter((call) => call.method !== "GET").length, 0);
});
