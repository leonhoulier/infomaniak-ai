# Connect Infomaniak

The primary public connection uses one shared hosted `/mcp` URL. Every customer
connects their own Infomaniak account through private browser consent in a
supported AI app, without an operator invitation, VPS, SSH access or local
installation. ChatGPT, Claude web and Grok web have connection guides.
Use `https://infomaniak-mcp.com/mcp` with OAuth and dynamic client
registration. The public pilot is live; native app compatibility remains
listed with its tested version at [client evidence](https://infomaniak-mcp.com/clients).
See [hosted onboarding and deployment](hosted.md).

For the hosted plugin, import `infomaniak-plugin-portable-0.3.3.zip` in a compatible
plugin host. The OpenAI-specific archive is `infomaniak-plugin-openai-0.3.3.zip`.
Claude's plugin uploader uses the portable ZIP and its included Claude metadata.
Complete OAuth in the browser; the hosted plugin has no API-token settings field.
Archive import, account connection and a successful model-driven tool call are
separate checks. The ZIP is not a local Claude Desktop `.mcpb` extension.

The following guide covers the local alternative. One token, entered privately.
No hosted service or author account is needed.
The first connection discovers your accounts and products with four read-only
tools. It cannot change services. If you have multiple accounts, you choose one.

## Start here

From the source checkout, install Node.js 22.13+ and run:

```sh
npm ci --ignore-scripts
npm run build
node dist/server.js setup
```

Choose your AI client. Setup never accepts a token as a command argument and
never asks you to paste one into chat. It does not launch a browser or silently
choose an Infomaniak account. An installed local package also exposes
`infomaniak-ai setup`; there is no npm or marketplace release yet.

Create your own token using [Infomaniak's API token settings guide](https://www.infomaniak.com/en/support/faq/2582/add-and-manage-infomaniak-api-tokens).
Account discovery needs the `accounts` scope. Add only product permissions needed
for your work; the token's permissions and the plugin's allowed operations are
separate limits. Keep the token in a password manager for rotation.

## Choose your client

| Client           | Enter the token                         | What setup does                                                                                                                   |
| ---------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code      | Sensitive plugin setting                | Shows the command to load this checkout as a plugin.                                                                              |
| Claude Desktop   | Extension's private settings            | Points to the bundled `.mcpb` extension.                                                                                          |
| VS Code          | Native password input when starting MCP | Adds a secret-free server and input to `.vscode/mcp.json`, preserving comments and other servers.                                 |
| Codex            | Hidden terminal prompt                  | Verifies account access, saves a private credential file and registers the file reference with `codex mcp add`.                   |
| Cursor           | Hidden terminal prompt                  | Verifies access, saves a private file and provides a native install link containing its path. You confirm installation in Cursor. |
| Other MCP client | Hidden terminal prompt                  | Verifies access and generates a connection JSON containing the private file path.                                                 |

Run directly with `--client claude-code`, `claude-desktop`, `vscode`, `codex`,
`cursor` or `generic`. Use `--dry-run` to preview without prompts, files, network
requests or client registration.

### Claude Code

Run `node dist/server.js setup --client claude-code`, then use the displayed
`claude --plugin-dir ...` command. Enter the token in the plugin's sensitive
configuration setting. Leave the advanced policy/backend fields empty initially.
Claude Code manages the sensitive setting in its system credential store;
setup itself never receives it. This is a local plugin load, not marketplace
installation.

### Claude Desktop

```sh
npm run package:desktop
```

This command builds a versioned `.mcpb` under `artifacts/`. Open the file it
reports in Claude Desktop and enter the token in
its private extension settings. The archive includes runtime dependencies. The
manifest requires Node.js 22.13+ from the host; users do not run npm inside the
extension. The archive is unsigned and has not been qualified through a native
Claude Desktop installation yet. See [bundle details](../desktop/README.md).

### VS Code

Run setup from your intended project folder, or supply its path explicitly:

```sh
node dist/server.js setup --client vscode --workspace /absolute/path/to/project
```

Open that folder in VS Code. Run **MCP: List Servers**, start Infomaniak and use
VS Code's password field. The JSON contains `${input:infomaniak-api-token}`,
never the value. Existing Infomaniak entries or conflicting input names are
preserved; setup asks you to resolve them instead of overwriting them.

This flow targets VS Code's MCP host. Its interactive inputs are not a portable
credential mechanism for Copilot CLI or other harnesses. Use the generic private
file connection for a different MCP host.

### Codex, Cursor and other clients

Run setup in your own terminal. The hidden prompt verifies access with one GET
request to Infomaniak's accounts endpoint before saving anything. Invalid tokens
are not retained. A successful check reports the number of accessible accounts,
without choosing one. These clients receive only `INFOMANIAK_API_TOKEN_FILE`.

Credentials are stored locally as plaintext files, not encrypted:

- macOS/Linux: `~/.config/infomaniak-ai/connections/CLIENT/`
- Windows: `%LOCALAPPDATA%/Infomaniak AI/connections/CLIENT/`
- Unix permissions: directory `0700`, token `0600`.

Choose another private directory with `--directory`. Git checkout destinations
are refused, including paths through symlinks. Existing connection directories
are never overwritten. Windows file privacy depends on your user profile ACLs;
this project has not qualified that path on Windows. Native client secret
settings are preferable where available.

For an already supplied secret, `--from-env` explicitly reads
`INFOMANIAK_API_TOKEN` or `INFOMANIAK_API_TOKEN_FILE`. Do not set both. Do not
put the raw token into a shell command. Non-interactive setup otherwise refuses
secret entry; nothing is automatically prompted on MCP's standard input.

Codex must already be installed. An existing Infomaniak Codex entry is preserved.
Cursor's install link contains a local path, not a token; open it on the same
computer. Generic clients import the displayed `mcp.json`. None of these flows
changes the client's approval policy.

## Your first useful question

> Show my Infomaniak services. If I have several accounts, let me choose one.

The assistant checks status, lists accessible accounts, asks you to choose when
needed, then discovers products for that account. Individual resource inspection
and reviewed writes require the separate [scoped policy setup](../README.md#advanced-scoped-reads-and-independently-approved-writes).
Onboarding does not enable writes or authorize changes to existing services.

## Rotate, disconnect or move

For native prompts, replace/reset the credential in the client's plugin or MCP
settings. For private file connections, remove the client entry and create a new
connection with a new `--directory`. After checking it works, revoke the old
token in Infomaniak and delete its old private connection folder. Revocation is
what stops a copied token from being used. If setup says registration failed,
it retains the displayed private folder for recovery; inspect it locally before
reconnecting. Do not paste its contents into chat.

Remove the Infomaniak server entry to disconnect. In VS Code, also remove the
unused input and reset its saved value through the client's MCP input controls.
Re-run setup if you move the checkout or remove its Node installation: local
connections intentionally refer to absolute executable paths.

The token reaches the local MCP process and Infomaniak. Returned service data
is available to your AI client under that client's terms. A masked prompt or
private file does not protect against other programs with access to your OS
account. ChatGPT web and OAuth sign-in use the separate [hosted flow](hosted.md), not
these local credential settings.

## Platform references and proof boundary

Configuration follows [Claude Code plugin configuration](https://code.claude.com/docs/en/plugins-reference),
[the MCPB manifest](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md),
[VS Code's MCP inputs](https://code.visualstudio.com/docs/agents/reference/mcp-configuration),
[Codex MCP configuration](https://developers.openai.com/codex/mcp) and
[Cursor install links](https://prod.cursor.com/docs/mcp/install-links).

Automated tests cover configuration generation, private storage, terminal paste
and cancellation, refusal paths and an actual MCP connection. They do not prove
native password dialogs, OS vault persistence or all client versions. See
[validation](validation.md) for recorded results and remaining gates.
