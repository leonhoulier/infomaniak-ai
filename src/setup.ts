import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { dirname, basename, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  lstat,
  realpath,
  readFile,
  mkdir,
  writeFile,
  rename,
  unlink,
  link,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parse, modify, applyEdits, type ParseError } from "jsonc-parser";
import { loadProviderSecret } from "./access.js";
import { PublicApi, RequestQueue, list, object, type Api } from "./provider.js";
import { PluginError } from "./errors.js";
import { terminalQuestion } from "./terminal.js";

export const CLIENTS = [
  "claude-code",
  "claude-desktop",
  "vscode",
  "codex",
  "cursor",
  "generic",
] as const;
export type Client = (typeof CLIENTS)[number];
const labels = [
  "Claude Code",
  "Claude Desktop",
  "VS Code",
  "Codex",
  "Cursor",
  "Another MCP client",
];
export const FIRST_PROMPT =
  "Show my Infomaniak services. If I have several accounts, let me choose one.";
export const TOKEN_HELP =
  "https://www.infomaniak.com/en/support/faq/2582/add-and-manage-infomaniak-api-tokens";
const root = fileURLToPath(new URL("../", import.meta.url));
const server = join(root, "dist", "server.js");
interface CommandResult {
  status: number | null;
  stderr?: string;
  error?: unknown;
}
export interface SetupIO {
  say: (text: string) => void;
  ask: (text: string, hidden?: boolean) => Promise<string>;
  api: (token: string) => Api;
  command: (name: string, args: string[]) => CommandResult;
  env: NodeJS.ProcessEnv;
}
const defaults: SetupIO = {
  say: (text) => process.stderr.write(text + "\n"),
  ask: terminalQuestion,
  api: (token) => new PublicApi(token, new RequestQueue()),
  command: (name, args) =>
    spawnSync(name, args, { encoding: "utf8", shell: false, timeout: 15_000, maxBuffer: 64_000 }),
  env: process.env,
};
const native = (client: Client) => ["claude-code", "claude-desktop", "vscode"].includes(client);
// A new discovery connection must not inherit another installation's policy or token source.
const discoveryEnv = {
  INFOMANIAK_API_TOKEN: "",
  INFOMANIAK_API_TOKEN_FILE: "",
  INFOMANIAK_POLICY_FILE: "",
  INFOMANIAK_MCP_SERVER_PATH: "",
  INFOMANIAK_MCP_SHA256: "",
};
function path(value: string): string {
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value))
    throw new PluginError("invalid_path", "Use an absolute path without control characters.");
  return value;
}
const quoted = (value: string) =>
  process.platform === "win32"
    ? "'" + value.replaceAll("'", "''") + "'"
    : "'" + value.replaceAll("'", "'\\''") + "'";
export function displayCommand(command: string, args: string[]): string {
  return (process.platform === "win32" ? "& " : "") + [command, ...args].map(quoted).join(" ");
}
async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
async function outsideGit(directory: string): Promise<void> {
  let ancestor = directory;
  const suffix: string[] = [];
  while (!(await exists(ancestor))) {
    suffix.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const canonical = join(await realpath(ancestor), ...suffix);
  for (let p = canonical; ; p = dirname(p)) {
    if (await exists(join(p, ".git")))
      throw new PluginError(
        "private_location_required",
        "Keep your credential folder outside a Git checkout.",
      );
    if (p === dirname(p)) break;
  }
}
export function clientPlan(
  client: Client,
  directory: string,
  workspace: string,
): Record<string, unknown> {
  const command = process.execPath,
    args = [server],
    secret = join(directory, "provider-token");
  const entry = { command, args, env: { ...discoveryEnv, INFOMANIAK_API_TOKEN_FILE: secret } };
  if (client === "claude-code")
    return {
      client,
      secret_entry: "Claude Code's sensitive plugin setting",
      command: "claude",
      args: ["--plugin-dir", root],
    };
  if (client === "claude-desktop")
    return {
      client,
      secret_entry: "Claude Desktop's extension settings",
      bundle: join(root, "artifacts", "infomaniak-ai-0.2.0.mcpb"),
    };
  if (client === "vscode")
    return {
      client,
      secret_entry: "VS Code's password input",
      file: join(workspace, ".vscode", "mcp.json"),
      configuration: {
        inputs: [
          {
            id: "infomaniak-api-token",
            type: "promptString",
            description: "Connect Infomaniak — paste your API token here, not in chat",
            password: true,
          },
        ],
        servers: {
          infomaniak: {
            type: "stdio",
            command,
            args,
            env: { ...discoveryEnv, INFOMANIAK_API_TOKEN: "${input:infomaniak-api-token}" },
          },
        },
      },
    };
  if (client === "codex")
    return {
      client,
      secret_entry: "Hidden terminal input; private credential file",
      command: "codex",
      args: [
        "mcp",
        "add",
        "infomaniak",
        ...Object.entries(entry.env).flatMap(([key, value]) => ["--env", key + "=" + value]),
        "--",
        command,
        ...args,
      ],
    };
  if (client === "cursor") {
    const uri = new URL("cursor://anysphere.cursor-deeplink/mcp/install");
    uri.searchParams.set("name", "infomaniak");
    uri.searchParams.set("config", Buffer.from(JSON.stringify(entry)).toString("base64"));
    return {
      client,
      secret_entry: "Hidden terminal input; private credential file",
      install_url: uri.href,
      configuration: { mcpServers: { infomaniak: entry } },
    };
  }
  return {
    client,
    secret_entry: "Hidden terminal input; private credential file",
    configuration: { mcpServers: { infomaniak: entry } },
  };
}

/** Merge a secret-free VS Code definition, retaining JSONC comments and other servers. */
export async function installVSCode(file: string, config: Record<string, unknown>): Promise<void> {
  const folder = dirname(file);
  if (await exists(folder)) {
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new PluginError("unsafe_config", "The .vscode folder must be a regular directory.");
  }
  await mkdir(folder, { recursive: true });
  const present = await exists(file);
  let text = "{}\n";
  if (present) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000)
      throw new PluginError(
        "unsafe_config",
        "Inspect the existing MCP configuration before setup.",
      );
    text = await readFile(file, "utf8");
  }
  const errors: ParseError[] = [],
    parsed: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new PluginError(
      "invalid_config",
      "The existing mcp.json could not be read. It was not changed.",
    );
  const current = parsed as Record<string, unknown>;
  if (
    current.servers !== undefined &&
    (!current.servers || typeof current.servers !== "object" || Array.isArray(current.servers))
  )
    throw new PluginError(
      "invalid_config",
      "The existing servers configuration must be an object.",
    );
  if ((current.servers as Record<string, unknown> | undefined)?.infomaniak !== undefined)
    throw new PluginError(
      "connection_exists",
      "An Infomaniak server is already configured here. Keep it or remove that entry before reconnecting.",
    );
  if (current.inputs !== undefined && !Array.isArray(current.inputs))
    throw new PluginError("invalid_config", "The existing inputs configuration must be a list.");
  const input = (config.inputs as Record<string, unknown>[])[0]!;
  if ((current.inputs as Record<string, unknown>[] | undefined)?.some((i) => i?.id === input.id))
    throw new PluginError(
      "connection_exists",
      "An input named infomaniak-api-token already exists. It was not changed.",
    );
  const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
  let result = applyEdits(
    text,
    modify(
      text,
      ["servers", "infomaniak"],
      (config.servers as Record<string, unknown>).infomaniak,
      options,
    ),
  );
  result = applyEdits(
    result,
    modify(
      result,
      current.inputs === undefined ? ["inputs"] : ["inputs", -1],
      current.inputs === undefined ? [input] : input,
      { ...options, isArrayInsertion: true },
    ),
  );
  const temporary = join(folder, ".infomaniak-" + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, result, { mode: 0o600, flag: "wx" });
    if (present) {
      if ((await readFile(file, "utf8")) !== text)
        throw new PluginError(
          "configuration_changed",
          "The MCP file changed during setup. Please run setup again.",
        );
      await rename(temporary, file);
    } else {
      await link(temporary, file);
      await unlink(temporary);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function setup(argv: string[], overrides: Partial<SetupIO> = {}): Promise<void> {
  const io = { ...defaults, ...overrides };
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        client: { type: "string" },
        directory: { type: "string" },
        workspace: { type: "string" },
        "dry-run": { type: "boolean" },
        "from-env": { type: "boolean" },
        help: { type: "boolean" },
      },
    }));
  } catch {
    throw new PluginError(
      "invalid_option",
      "Use setup --client claude-code|claude-desktop|vscode|codex|cursor|generic. Never pass a token as an argument.",
    );
  }
  if (values.help) {
    io.say(
      "Connect Infomaniak\n  infomaniak-ai setup [--client CLIENT] [--workspace FOLDER] [--directory PRIVATE_FOLDER]\n  --dry-run   Preview without credentials, network requests or file changes.\n  --from-env  Use an already supplied INFOMANIAK_API_TOKEN or its _FILE source.\n\nYour first connection is read-only. A token is never an argument.",
    );
    return;
  }
  let client = values.client;
  io.say(
    "\nConnect Infomaniak\nYour services, in your AI workspace. Start read-only; make changes later with a separate approval.\n",
  );
  if (!client) {
    io.say(labels.map((label, i) => `  ${i + 1}. ${label}`).join("\n"));
    const choice = await io.ask("\nWhere would you like to connect? [1-6] ");
    client = CLIENTS[Number(choice) - 1];
  }
  if (!CLIENTS.includes(client as Client))
    throw new PluginError("invalid_client", "Choose one of the six listed clients.");
  const selected = client as Client;
  const base =
    process.platform === "win32"
      ? join(io.env.LOCALAPPDATA ?? homedir(), "Infomaniak AI")
      : join(homedir(), ".config", "infomaniak-ai");
  const directory = path(resolve(values.directory ?? join(base, "connections", selected)));
  const workspace = path(resolve(values.workspace ?? process.cwd()));
  const plan = clientPlan(selected, directory, workspace);
  if (values["dry-run"]) {
    io.say(JSON.stringify({ ...plan, first_prompt: FIRST_PROMPT, writes_enabled: false }, null, 2));
    return;
  }
  if (native(selected) && values["from-env"])
    throw new PluginError(
      "native_secret_entry",
      "This client has its own secret prompt. Enter the token there; setup does not need it.",
    );
  if (native(selected))
    io.say(
      "Need a token? Create one with the accounts scope and only the product permissions you need:\n  " +
        TOKEN_HELP +
        "\n",
    );
  if (selected === "claude-code") {
    io.say(
      "Claude Code will ask for your Infomaniak API token in its private plugin setting.\nRun:\n  " +
        displayCommand("claude", plan.args as string[]),
    );
  } else if (selected === "claude-desktop") {
    io.say(
      "Open the supplied infomaniak-ai-0.2.0.mcpb in Claude Desktop, then connect in the extension's private settings. No terminal token entry or server hosting is needed.\nBundle location when built from source:\n  " +
        String(plan.bundle),
    );
  } else if (selected === "vscode") {
    await installVSCode(String(plan.file), plan.configuration as Record<string, unknown>);
    io.say(
      "Ready in " +
        workspace +
        ".\nOpen this folder in VS Code and start Infomaniak from MCP: List Servers. VS Code will ask for the token in a password field and manage the saved input.",
    );
  } else {
    await outsideGit(directory);
    if (await exists(directory))
      throw new PluginError(
        "connection_exists",
        "This private connection folder already exists. It was not overwritten. Choose another --directory to create a separate connection.",
      );
    if (selected === "codex") {
      const check = io.command("codex", ["mcp", "get", "infomaniak", "--json"]);
      if (check.error || check.status === null)
        throw new PluginError(
          "client_missing",
          "Install Codex first, or choose generic to generate a connection file.",
        );
      if (check.status === 0)
        throw new PluginError(
          "connection_exists",
          "Codex already has an Infomaniak connection. It was not overwritten.",
        );
      if (!/no mcp server named|not found|not configured/i.test(check.stderr ?? ""))
        throw new PluginError(
          "client_config_error",
          "Codex configuration could not be checked. Fix it before connecting.",
        );
    }
    io.say(
      "Create a token in Infomaniak's API token settings with the accounts scope and only the product permissions you need:\n  " +
        TOKEN_HELP +
        "\n\nIt will be saved in a private local file, outside your project. It is not encrypted. Nothing is pasted into chat or client JSON.",
    );
    const token = values["from-env"]
      ? loadProviderSecret("INFOMANIAK_API_TOKEN", io.env)
      : loadProviderSecret("INFOMANIAK_API_TOKEN", {
          INFOMANIAK_API_TOKEN: await io.ask("\nPaste your token here (hidden): ", true),
        });
    let accounts;
    try {
      accounts = list(await io.api(token).request("GET", "/1/accounts")).map(object);
      if (accounts.some((a) => !Number.isSafeInteger(a.id))) throw new Error("Invalid accounts");
    } catch {
      throw new PluginError(
        "connection_failed",
        "Infomaniak could not confirm account access. Check the token and accounts permission, then retry. No token was saved.",
      );
    }
    io.say(
      `\nConnected · ${accounts.length} ${accounts.length === 1 ? "account" : "accounts"} available. No account was chosen for you.`,
    );
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    try {
      await writeFile(join(directory, "provider-token"), token + "\n", { mode: 0o600, flag: "wx" });
      const configuration =
        plan.configuration ?? clientPlan("generic", directory, workspace).configuration;
      await writeFile(join(directory, "mcp.json"), JSON.stringify(configuration, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
    } catch {
      await rm(directory, { recursive: true, force: true });
      throw new PluginError(
        "storage_failed",
        "The private connection could not be saved. No token was retained.",
      );
    }
    if (selected === "codex") {
      const added = io.command("codex", plan.args as string[]);
      if (added.status !== 0 || added.error)
        throw new PluginError(
          "registration_failed",
          "Your private connection is saved, but Codex registration did not finish. Connection folder: " +
            directory,
        );
      io.say("Added to Codex. Start a new session, or check /mcp.");
    } else if (selected === "cursor")
      io.say(
        "Add with Cursor's installer (the link contains a file reference, never your token):\n  " +
          String(plan.install_url),
      );
    else io.say("Import this connection into your MCP client:\n  " + join(directory, "mcp.json"));
    io.say(
      "To disconnect, remove the client's Infomaniak entry and revoke the token in Infomaniak. Your local connection folder is " +
        directory +
        ".",
    );
  }
  io.say(
    "\nThen ask:\n  “" +
      FIRST_PROMPT +
      "”\n\nYour connection starts with read-only account and product discovery. Resource-scoped reads and writes are a separate setup step. Never paste a token into chat.",
  );
}
