import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpBackend } from "../dist/backend.js";
import { loadSettings } from "../dist/config.js";

async function settings(fixture = "backend.mjs") {
  const path = fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url));
  return loadSettings({
    INFOMANIAK_API_TOKEN: "fixture-".repeat(5),
    INFOMANIAK_MCP_SERVER_PATH: path,
    INFOMANIAK_MCP_SHA256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  });
}

async function connect(t) {
  const env = {
    ...getDefaultEnvironment(),
    ...(await settings()),
    UNRELATED_CREDENTIAL: "fixture",
    INFOMANIAK_SASESSION: "fixture",
    INFOMANIAK_XSRF_TOKEN: "fixture",
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/server.js", import.meta.url))],
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "fixture-plugin-client", version: "0.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

test(
  "built gateway advertises three provider tools and two documentation tools and uses a real MCP child",
  { timeout: 30_000 },
  async (t) => {
    const client = await connect(t);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        "infomaniak_status",
        "infomaniak_search",
        "infomaniak_read",
        "infomaniak_docs_search",
        "infomaniak_docs_read",
      ],
    );
    assert(tools.every((tool) => tool.annotations.readOnlyHint === true));
    const status = await client.callTool({ name: "infomaniak_status", arguments: {} });
    assert.equal(status.structuredContent.backend.name, "fixture-adapter");
    assert.equal(status.structuredContent.writes_enabled, false);
    assert.deepEqual(status.structuredContent.available_reads, ["infomaniak_list_domains"]);
    const result = await client.callTool({
      name: "infomaniak_read",
      arguments: { operation: "infomaniak_list_domains", arguments: { account_id: 10 } },
    });
    assert.equal(result.structuredContent.data.account_id, 10);
    assert.equal(result.structuredContent.data.adapter_auth, "disabled");
    assert.equal(result.structuredContent.data.adapter_read_only, "1");
    assert.equal(result.structuredContent.data.unexpected_env, false);
  },
);

test(
  "policy and upstream errors stay MCP errors through the standard SDK",
  { timeout: 30_000 },
  async (t) => {
    const client = await connect(t);
    for (const [operation, args, code] of [
      ["infomaniak_api_call", { method: "DELETE" }, "operation_denied"],
      ["infomaniak_list_domains", {}, "account_required"],
      ["infomaniak_list_domains", { account_id: 10, simulate: "error" }, "upstream_error"],
    ]) {
      const result = await client.callTool({
        name: "infomaniak_read",
        arguments: { operation, arguments: args },
      });
      assert.equal(result.isError, true);
      assert.equal(JSON.parse(result.content[0].text).code, code);
      assert(!JSON.stringify(result).includes("fixture-".repeat(5)));
    }
  },
);

test(
  "preloaded transport guard blocks a backend handler's attempted write",
  { timeout: 30_000 },
  async (t) => {
    const client = await connect(t);
    const result = await client.callTool({
      name: "infomaniak_read",
      arguments: {
        operation: "infomaniak_list_domains",
        arguments: { account_id: 10, simulate: "write" },
      },
    });
    assert.equal(result.isError, true);
    const error = JSON.parse(result.content[0].text);
    assert.equal(error.code, "upstream_error");
    assert.match(error.message, /Only GET requests/);
  },
);

test(
  "repeating catalogue cursors and duplicate tools fail without partial success",
  { timeout: 30_000 },
  async () => {
    for (const fixture of ["loop.mjs", "duplicate.mjs"]) {
      const backend = new McpBackend(await settings(fixture));
      try {
        await assert.rejects(backend.catalogue(), { code: "invalid_catalogue" });
      } finally {
        await backend.close();
      }
    }
  },
);

test("doctor validates a pinned local build without connecting to its server", async () => {
  const env = { ...getDefaultEnvironment(), ...(await settings()) };
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../dist/server.js", import.meta.url)), "--doctor"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    configured: true,
    backend_integrity: "matched",
    browser_auth: "disabled",
    mode: "read-only",
    api_permissions_tested: false,
  });
});

test("native plugin metadata matches the package and keeps secrets out of the skill", async () => {
  const root = new URL("../", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL(".claude-plugin/plugin.json", root), "utf8"));
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.userConfig.api_token.sensitive, true);
  assert.deepEqual(manifest.mcpServers.infomaniak.args, ["${CLAUDE_PLUGIN_ROOT}/dist/server.js"]);
  const skill = await readFile(new URL("skills/infomaniak/SKILL.md", root), "utf8");
  assert(!skill.includes("${user_config.api_token}"));
  assert(skill.includes("not independent human approval"));
});
