import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { Discovery } from "../dist/discovery.js";
import { FixtureApi, PROVIDER_KEY } from "./fixtures/api.mjs";
test("public discovery needs no author's account, backend, state directory or write grant", async () => {
  const api = new FixtureApi(),
    gateway = await Discovery.create(PROVIDER_KEY, api);
  const status = await gateway.dispatch("infomaniak_status", {});
  assert.equal(status.mode, "discovery-only");
  assert.equal(status.writes_enabled, false);
  assert.equal(api.calls.length, 0);
  assert.deepEqual(
    (await gateway.dispatch("infomaniak_read", { operation: "accounts.list" })).data.map(
      (r) => r.id,
    ),
    [10, 20],
  );
  const products = await gateway.dispatch("infomaniak_read", {
    operation: "products.list",
    arguments: { account_id: 20 },
  });
  assert.equal(products.data.length, 1);
  await assert.rejects(
    gateway.dispatch("infomaniak_read", {
      operation: "products.list",
      arguments: { account_id: 999 },
    }),
    { code: "access_denied" },
  );
  await assert.rejects(gateway.dispatch("infomaniak_plan", { operation: "dns.record.create" }), {
    code: "operation_denied",
  });
  await assert.rejects(
    gateway.dispatch("infomaniak_read", {
      operation: "accounts.list",
      arguments: { confirmation_token: "anything" },
    }),
  );
  assert(api.calls.every((r) => r.method === "GET"));
});
test("token-only native entrypoint advertises a usable read-only public installation", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/server.js", import.meta.url))],
    env: { ...getDefaultEnvironment(), INFOMANIAK_API_TOKEN: PROVIDER_KEY },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "public-installation-test", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 6);
  const status = await client.callTool({ name: "infomaniak_status", arguments: {} });
  assert.equal(status.structuredContent.mode, "discovery-only");
  const rejected = await client.callTool({
    name: "infomaniak_execute",
    arguments: { approved: true },
  });
  assert.equal(rejected.isError, true);
});
