import assert from "node:assert/strict";
import { test } from "node:test";

import { Gateway } from "../dist/gateway.js";

function tool(name, readOnlyHint = true) {
  return {
    name,
    description: "Untrusted description",
    inputSchema: { type: "object", properties: { account_id: { type: "number" } } },
    annotations: { readOnlyHint },
  };
}

class FakeBackend {
  tools = [
    tool("infomaniak_list_organizations"),
    tool("infomaniak_list_domains"),
    tool("infomaniak_list_vps"),
    tool("infomaniak_api_call"),
  ];
  lists = 0;
  reads = [];
  response = { content: [], structuredContent: { count: 0, domains: [] } };
  async catalogue() {
    this.lists++;
    return { name: "fixture", version: "0.0.0", tools: this.tools };
  }
  async read(...args) {
    this.reads.push(args);
    return this.response;
  }
}

test("status distinguishes advertised reads, unsupported legacy VPS and future deployment", async () => {
  const backend = new FakeBackend();
  const result = await new Gateway(backend).dispatch("infomaniak_status", {});
  assert.deepEqual(result.available_reads, [
    "infomaniak_list_organizations",
    "infomaniak_list_domains",
  ]);
  assert(result.unavailable_reads.includes("infomaniak_list_vps"));
  assert.equal(result.permissions_verified, false);
  assert.equal(result.writes_enabled, false);
  assert.equal(result.deployment_enabled, false);
  assert.equal(backend.reads.length, 0);
});

test("search exposes only matching reviewed schemas and makes account selection required", async () => {
  const backend = new FakeBackend();
  const gateway = new Gateway(backend);
  const result = await gateway.dispatch("infomaniak_search", { query: "domains", limit: 1 });
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0].operation, "infomaniak_list_domains");
  assert.deepEqual(result.operations[0].input_schema.required, ["account_id"]);
  assert(!JSON.stringify(result).includes("Untrusted description"));
  assert.deepEqual(
    (await gateway.dispatch("infomaniak_search", { query: "zzzznotanoperation" })).operations,
    [],
  );
});

test("write rejection happens before connecting or forwarding anything", async () => {
  const backend = new FakeBackend();
  await assert.rejects(
    new Gateway(backend).dispatch("infomaniak_read", {
      operation: "infomaniak_api_call",
      arguments: { method: "POST" },
    }),
    { code: "operation_denied" },
  );
  assert.equal(backend.lists, 0);
  assert.equal(backend.reads.length, 0);
});

test("explicit account selection is enforced before forwarding a read", async () => {
  const backend = new FakeBackend();
  const gateway = new Gateway(backend);
  await assert.rejects(
    gateway.dispatch("infomaniak_read", { operation: "infomaniak_list_domains" }),
    { code: "account_required" },
  );
  const result = await gateway.dispatch("infomaniak_read", {
    operation: "infomaniak_list_domains",
    arguments: { account_id: 10 },
  });
  assert.deepEqual(backend.reads[0].slice(0, 2), ["infomaniak_list_domains", { account_id: 10 }]);
  assert.deepEqual(result.data, { count: 0, domains: [] });
});

test("missing operations and non-read-only annotations fail closed", async () => {
  const backend = new FakeBackend();
  const gateway = new Gateway(backend);
  await assert.rejects(
    gateway.dispatch("infomaniak_read", {
      operation: "infomaniak_dns_export",
      arguments: { zone: "example.com" },
    }),
    { code: "operation_unavailable" },
  );
  backend.tools = [tool("infomaniak_list_domains", false)];
  await assert.rejects(
    gateway.dispatch("infomaniak_read", {
      operation: "infomaniak_list_domains",
      arguments: { account_id: 10 },
    }),
    { code: "operation_unavailable" },
  );
  assert.equal(backend.reads.length, 0);
});

test("upstream errors remain errors and configured credentials are redacted", async () => {
  const backend = new FakeBackend();
  const credential = "fixture-".repeat(5);
  backend.response = {
    isError: true,
    content: [{ type: "text", text: `Denied Bearer ${credential}` }],
  };
  const gateway = new Gateway(backend, [credential]);
  await assert.rejects(
    gateway.dispatch("infomaniak_read", { operation: "infomaniak_list_organizations" }),
    (error) => {
      assert.equal(error.code, "upstream_error");
      assert(!error.message.includes(credential));
      return true;
    },
  );
});

test("known fields and active credential strings are redacted from successful reads", async () => {
  const backend = new FakeBackend();
  const credential = "fixture-".repeat(5);
  backend.response = { content: [], structuredContent: { password: "hidden", note: credential } };
  const result = await new Gateway(backend, [credential]).dispatch("infomaniak_read", {
    operation: "infomaniak_list_organizations",
  });
  assert.deepEqual(result.data, { password: "<redacted>", note: "<redacted>" });
});

test("invalid top-level inputs and unknown tools fail clearly", async () => {
  const gateway = new Gateway(new FakeBackend());
  await assert.rejects(gateway.dispatch("infomaniak_search", { query: "domains", limit: 0 }));
  await assert.rejects(gateway.dispatch("infomaniak_status", { arbitrary: true }));
  await assert.rejects(gateway.dispatch("unknown", {}), { code: "unknown_tool" });
});

test("VPS token-only reads require the reviewed companion capability", async () => {
  const backend = new FakeBackend();
  const gateway = new Gateway(backend);
  backend.tools.push(tool("infomaniak_get_vps_firewall"));
  assert(
    (await gateway.dispatch("infomaniak_status", {})).available_reads.includes(
      "infomaniak_list_vps",
    ),
  );
  backend.tools = [tool("infomaniak_list_vps"), tool("infomaniak_get_vps_firewall", false)];
  assert(
    !(await gateway.dispatch("infomaniak_status", {})).available_reads.includes(
      "infomaniak_list_vps",
    ),
  );
});

test("oversize read arguments fail before connecting", async () => {
  const backend = new FakeBackend();
  await assert.rejects(
    new Gateway(backend).dispatch("infomaniak_read", {
      operation: "infomaniak_list_organizations",
      arguments: { data: "x".repeat(64_001) },
    }),
    { code: "invalid_input" },
  );
  assert.equal(backend.lists, 0);
});
