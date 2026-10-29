import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "jsonc-parser";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { setup, clientPlan, CLIENTS, installVSCode } from "../dist/setup.js";
import { loadProviderSecret } from "../dist/access.js";
const TOKEN = "fixture-onboarding-provider-".repeat(3);
const entry = fileURLToPath(new URL("../dist/server.js", import.meta.url));
async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), "ik-onboarding-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = [],
    calls = [],
    commands = [];
  const io = {
    say: (text) => output.push(text),
    ask: async (_text, hidden) => {
      assert.equal(hidden, true);
      return TOKEN;
    },
    api: (token) => {
      assert.equal(token, TOKEN);
      return {
        request: async (method, path) => {
          calls.push([method, path]);
          return [{ id: 10 }, { id: 20 }];
        },
      };
    },
    command: (name, args) => {
      commands.push({ name, args });
      return args[1] === "get"
        ? { status: 1, stderr: "No MCP server named infomaniak" }
        : { status: 0 };
    },
    env: { INFOMANIAK_API_TOKEN: TOKEN },
  };
  return { directory, profile: join(directory, "connection"), output, calls, commands, io };
}
test("every client has a secret-free preview with no API, credential prompt or mutations", async (t) => {
  const f = await harness(t);
  f.io.ask = async () => {
    throw new Error("No prompt in preview");
  };
  for (const client of CLIENTS)
    await setup(
      ["--client", client, "--directory", f.profile, "--workspace", f.directory, "--dry-run"],
      f.io,
    );
  assert.equal(f.calls.length, 0);
  assert.equal(f.commands.length, 0);
  assert(!f.output.join("").includes(TOKEN));
  await assert.rejects(stat(f.profile), { code: "ENOENT" });
});
test("Claude clients use native sensitive configuration and never ask setup for a token", async (t) => {
  const f = await harness(t);
  f.io.ask = async () => {
    throw new Error("Use the client prompt");
  };
  for (const client of ["claude-code", "claude-desktop"]) await setup(["--client", client], f.io);
  assert.equal(f.calls.length, 0);
  assert.equal(f.commands.length, 0);
  await assert.rejects(setup(["--client", "claude-code", "--from-env"], f.io), {
    code: "native_secret_entry",
  });
});
test("VS Code installs a native password input and preserves JSONC comments and other servers", async (t) => {
  const f = await harness(t);
  await mkdir(join(f.directory, ".vscode"));
  const file = join(f.directory, ".vscode", "mcp.json");
  await writeFile(
    file,
    '{\n // Keep my existing setup\n "servers": {"other": {"command":"existing"}},\n "inputs": [/* Keep input comment */ {"id":"another","type":"promptString","description":"Other"}],\n}\n',
  );
  f.io.ask = async () => {
    throw new Error("Use VS Code's password field");
  };
  await setup(["--client", "vscode", "--workspace", f.directory], f.io);
  const raw = await readFile(file, "utf8"),
    config = parse(raw);
  assert(raw.includes("Keep my existing setup"));
  assert(raw.includes("Keep input comment"));
  assert.equal(config.servers.other.command, "existing");
  assert.equal(config.inputs.length, 2);
  assert.equal(config.inputs[1].password, true);
  assert.equal(config.servers.infomaniak.env.INFOMANIAK_API_TOKEN, "${input:infomaniak-api-token}");
  assert(!raw.includes(TOKEN));
  assert.equal(f.calls.length, 0);
  await assert.rejects(setup(["--client", "vscode", "--workspace", f.directory], f.io), {
    code: "connection_exists",
  });
  assert.equal(await readFile(file, "utf8"), raw);
});
test("invalid or symlinked VS Code configurations are never overwritten", async (t) => {
  const f = await harness(t);
  await mkdir(join(f.directory, ".vscode"));
  const file = join(f.directory, ".vscode", "mcp.json"),
    original = "{broken";
  await writeFile(file, original);
  const config = clientPlan("vscode", f.profile, f.directory).configuration;
  await assert.rejects(installVSCode(file, config), { code: "invalid_config" });
  assert.equal(await readFile(file, "utf8"), original);
  await rm(file);
  await symlink(join(f.directory, "other.json"), file);
  await assert.rejects(installVSCode(file, config), { code: "unsafe_config" });
});
test("fallback verifies GET-only access before storing a token privately, outside client JSON", async (t) => {
  const f = await harness(t);
  await setup(["--client", "generic", "--directory", f.profile], f.io);
  assert.deepEqual(f.calls, [["GET", "/1/accounts"]]);
  const file = join(f.profile, "provider-token"),
    config = JSON.parse(await readFile(join(f.profile, "mcp.json"), "utf8"));
  assert.equal(
    loadProviderSecret("INFOMANIAK_API_TOKEN", { INFOMANIAK_API_TOKEN_FILE: file }),
    TOKEN,
  );
  assert.equal(config.mcpServers.infomaniak.env.INFOMANIAK_API_TOKEN_FILE, file);
  assert(!JSON.stringify(config).includes(TOKEN));
  assert(!f.output.join("").includes(TOKEN));
  if (process.platform !== "win32") {
    assert.equal((await stat(f.profile)).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
});
test("a rejected token never creates a credential file or client entry", async (t) => {
  const f = await harness(t);
  f.io.api = () => ({
    request: async () => {
      throw new Error("provider might echo " + TOKEN);
    },
  });
  await assert.rejects(setup(["--client", "generic", "--directory", f.profile], f.io), (e) => {
    assert.equal(e.code, "connection_failed");
    assert(!e.message.includes(TOKEN));
    return true;
  });
  await assert.rejects(stat(f.profile), { code: "ENOENT" });
  assert.equal(f.commands.length, 0);
});
test("existing private profiles are preserved before asking for any credential", async (t) => {
  const f = await harness(t);
  await mkdir(f.profile);
  await writeFile(join(f.profile, "keep"), "original");
  f.io.ask = async () => {
    throw new Error("Do not request another token");
  };
  await assert.rejects(setup(["--client", "generic", "--directory", f.profile], f.io), {
    code: "connection_exists",
  });
  assert.equal(await readFile(join(f.profile, "keep"), "utf8"), "original");
  assert.equal(f.calls.length, 0);
});
test("credentials cannot be saved inside a Git checkout, including through a directory symlink", async (t) => {
  const f = await harness(t);
  await mkdir(join(f.directory, ".git"));
  await mkdir(join(f.directory, "nested"));
  await symlink(join(f.directory, "nested"), join(f.directory, "alias"));
  f.io.ask = async () => {
    throw new Error("Fail before token entry");
  };
  await assert.rejects(
    setup(["--client", "generic", "--directory", join(f.directory, "alias", "private")], f.io),
    { code: "private_location_required" },
  );
  assert.equal(f.calls.length, 0);
});
test("Codex registration passes only a credential-file reference and preserves existing entries", async (t) => {
  const f = await harness(t);
  await setup(["--client", "codex", "--directory", f.profile, "--from-env"], f.io);
  assert.equal(f.commands.length, 2);
  assert.equal(f.commands[1].args[1], "add");
  assert(
    f.commands[1].args.some(
      (a) => a === "INFOMANIAK_API_TOKEN_FILE=" + join(f.profile, "provider-token"),
    ),
  );
  assert(!JSON.stringify(f.commands).includes(TOKEN));
  f.io.command = () => ({ status: 0 });
  await assert.rejects(
    setup(["--client", "codex", "--directory", join(f.directory, "new")], f.io),
    { code: "connection_exists" },
  );
});
test("Cursor's native installer URL contains no credential, even after base64 decoding", async (t) => {
  const f = await harness(t);
  await setup(["--client", "cursor", "--directory", f.profile, "--from-env"], f.io);
  const url = new URL(clientPlan("cursor", f.profile, f.directory).install_url);
  assert.equal(url.protocol, "cursor:");
  const decoded = Buffer.from(url.searchParams.get("config"), "base64").toString();
  assert(!decoded.includes(TOKEN));
  assert.equal(
    JSON.parse(decoded).env.INFOMANIAK_API_TOKEN_FILE,
    join(f.profile, "provider-token"),
  );
  assert(!f.output.join("").includes(TOKEN));
});
test("generated fallback configuration starts real MCP discovery with the private file source", async (t) => {
  const f = await harness(t);
  await setup(["--client", "generic", "--directory", f.profile, "--from-env"], f.io);
  const entry = JSON.parse(await readFile(join(f.profile, "mcp.json"), "utf8")).mcpServers
    .infomaniak;
  const transport = new StdioClientTransport({
    ...entry,
    env: {
      ...getDefaultEnvironment(),
      INFOMANIAK_API_TOKEN: "fixture-inherited-provider-token",
      INFOMANIAK_POLICY_FILE: "/must-not-load-inherited-policy.json",
      INFOMANIAK_MCP_SERVER_PATH: "/must-not-launch-inherited-backend.js",
      INFOMANIAK_MCP_SHA256: "a".repeat(64),
      ...entry.env,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "onboarding-install-test", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 6);
  const result = await client.callTool({ name: "infomaniak_status", arguments: {} });
  assert.equal(result.structuredContent.writes_enabled, false);
  assert.match(client.getInstructions(), /never ask for tokens in chat/i);
});
test("CLI rejects token arguments and piped secret entry without echoing either", async (t) => {
  const f = await harness(t);
  for (const args of [
    ["setup", "--token=" + TOKEN],
    ["setup", "--client", "generic", "--directory", f.profile],
  ]) {
    const result = spawnSync(process.execPath, [entry, ...args], {
      env: getDefaultEnvironment(),
      input: TOKEN + "\n",
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert(!(result.stdout + result.stderr).includes(TOKEN));
  }
  await assert.rejects(stat(f.profile), { code: "ENOENT" });
});
test("native manifests request exactly one sensitive token, outside command arguments", async () => {
  const desktop = JSON.parse(
    await readFile(new URL("../desktop/manifest.json", import.meta.url), "utf8"),
  );
  const claude = JSON.parse(
    await readFile(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(Object.keys(desktop.user_config), ["api_token"]);
  for (const field of [desktop.user_config.api_token, claude.userConfig.api_token]) {
    assert.equal(field.sensitive, true);
    assert.equal(field.required, true);
  }
  assert(!JSON.stringify(desktop.server.mcp_config.args).includes("user_config"));
  assert.equal(desktop.server.mcp_config.env.INFOMANIAK_API_TOKEN, "${user_config.api_token}");
});

test(
  "real terminal entry hides an immediate paste and exits cleanly on Ctrl+C",
  { skip: process.platform === "win32", timeout: 25_000 },
  () => {
    const code = `
import os,pty,subprocess,select,time,sys,json
secret=b"fixture-hidden-paste-value"
results=[]
for value in (secret+b"\\n",b"\\x03"):
    master,slave=pty.openpty()
    p=subprocess.Popen([sys.argv[1],sys.argv[2]],stdin=slave,stdout=slave,stderr=slave,close_fds=True)
    os.close(slave)
    data=b"";sent=False;deadline=time.monotonic()+10
    try:
        while time.monotonic()<deadline:
            if select.select([master],[],[],.1)[0]:
                try: part=os.read(master,4096)
                except OSError: break
                if not part: break
                data+=part
                if not sent and b"Private token: " in data:
                    os.write(master,value);sent=True
            if p.poll() is not None: break
        p.wait(timeout=2)
        assert sent and secret not in data
        assert p.returncode==(0 if value.startswith(secret) else 2),data
        results.append(True)
    finally:
        if p.poll() is None:p.kill();p.wait()
        os.close(master)
print(json.dumps({"hidden_paste":results[0],"cancelled":results[1]}))
`;
    const result = spawnSync(
      "python3",
      [
        "-c",
        code,
        process.execPath,
        fileURLToPath(new URL("./fixtures/terminal.mjs", import.meta.url)),
      ],
      { encoding: "utf8", timeout: 23_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { hidden_paste: true, cancelled: true });
  },
);
