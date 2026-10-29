import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, chmod, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { credential, loadAccess, digest } from "../dist/access.js";
import { fixture, createArgs, PROVIDER_KEY, policy } from "./fixtures/api.mjs";
const admin = fileURLToPath(new URL("../dist/admin.js", import.meta.url));
const server = fileURLToPath(new URL("../dist/server.js", import.meta.url));
test("initialization writes separate private keys without printing them or overwriting an existing installation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ik-init-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "private");
  const args = [
    admin,
    "init",
    "--directory",
    directory,
    "--account",
    "10",
    "--zone",
    "example.com",
  ];
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: getDefaultEnvironment(),
  });
  assert.equal(result.status, 0, result.stderr);
  const client = (await readFile(join(directory, "client", "mcp-token"), "utf8")).trim();
  const human = (await readFile(join(directory, "human", "approval-key"), "utf8")).trim();
  assert.notEqual(client, human);
  assert(!result.stdout.includes(client));
  assert(!result.stdout.includes(human));
  const config = await loadAccess(join(directory, "access.local.json"));
  assert.equal(config.principals[0].writes, "disabled");
  assert.equal(config.principals[0].access_token_sha256, digest(client));
  assert.equal((await stat(join(directory, "client", "mcp-token"))).mode & 0o777, 0o600);
  assert.notEqual(
    spawnSync(process.execPath, args, { encoding: "utf8", env: getDefaultEnvironment() }).status,
    0,
  );
  assert.equal((await readFile(join(directory, "human", "approval-key"), "utf8")).trim(), human);
});
test("private secret-file loading rejects loose permissions, conflicts and invalid policy permissions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ik-secret-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "provider"),
    p = policy(root).principals[0];
  await writeFile(file, PROVIDER_KEY + "\n", { mode: 0o600 });
  assert.equal(credential(p, { FIXTURE_PROVIDER_FILE: file }), PROVIDER_KEY);
  assert.throws(
    () => credential(p, { FIXTURE_PROVIDER: PROVIDER_KEY, FIXTURE_PROVIDER_FILE: file }),
    { code: "invalid_configuration" },
  );
  await chmod(file, 0o644);
  assert.throws(() => credential(p, { FIXTURE_PROVIDER_FILE: file }), {
    code: "configuration_required",
  });
  const cfg = join(root, "access.json");
  await writeFile(cfg, JSON.stringify(policy(root)), { mode: 0o644 });
  await assert.rejects(loadAccess(cfg), { code: "invalid_configuration" });
});
test("noninteractive administrative approval fails without granting execution", async (t) => {
  const f = await fixture(t),
    p = await f.engine.plan("dns.record.create", createArgs);
  const config = join(f.directory, "access.local.json");
  await writeFile(config, JSON.stringify(f.config), { mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    [admin, "approve", "--config", config, "--id", p.id, "--hash", p.hash],
    { encoding: "utf8", env: getDefaultEnvironment(), input: "APPROVE\n" },
  );
  assert.notEqual(result.status, 0);
  assert(result.stderr.includes("human_required"));
  assert.equal(f.engine.status(p.id).state, "planned");
});
test("actual stdio entrypoint runs the scoped edition without touching provider data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ik-stdio-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cfg = policy(root);
  cfg.principals[0].writes = "disabled";
  const path = join(root, "access.local.json");
  await writeFile(path, JSON.stringify(cfg), { mode: 0o600 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server, "--config", path],
    env: { ...getDefaultEnvironment(), FIXTURE_PROVIDER: PROVIDER_KEY },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "scoped-stdio-test", version: "1.0" });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  const status = await client.callTool({ name: "infomaniak_status", arguments: {} });
  assert.equal(status.structuredContent.catalogue.operations, 1514);
  assert.equal(status.structuredContent.writes_enabled, false);
  const denied = await client.callTool({
    name: "infomaniak_plan",
    arguments: { operation: "dns.record.create", arguments: createArgs },
  });
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.content[0].text).code, "writes_disabled");
});

test("healthcheck reaches IPv4 and IPv6 listeners using the configured public Host header", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ik-health-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const host of ["127.0.0.1", "::1"]) {
    const http = createServer((req, res) => {
      res.statusCode = req.url === "/healthz" && req.headers.host === "gateway.example" ? 200 : 403;
      res.end();
    });
    http.listen(0, host);
    await once(http, "listening");
    try {
      const cfg = policy(root);
      cfg.remote = { host, port: http.address().port, public_origin: "https://gateway.example" };
      const path = join(root, "health.local.json");
      await writeFile(path, JSON.stringify(cfg), { mode: 0o600 });
      await promisify(execFile)(
        process.execPath,
        [fileURLToPath(new URL("../dist/healthcheck.js", import.meta.url))],
        {
          env: { ...getDefaultEnvironment(), INFOMANIAK_POLICY_FILE: path },
          timeout: 10_000,
        },
      );
    } finally {
      await new Promise((resolve) => http.close(resolve));
    }
  }
});
