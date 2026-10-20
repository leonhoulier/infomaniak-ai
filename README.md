# Infomaniak AI

An independent, unofficial AI plugin for Infomaniak. The product goal is broad
coverage of Infomaniak's supported APIs: discover → inspect → plan → approve →
execute → verify, across products and accounts.

**This is a local read-only foundation.** It does not deploy, promote, roll back or
execute SSH. See [the product plan](docs/product.md) and
[API coverage and write policy](docs/api-coverage.md) for the phased scope.

The plugin reuses [infomaniak-mcp-agent](https://github.com/Mogacode-ma/infomaniak-mcp-agent)
through MCP. Provider fixes remain separate upstream contributions. This repository
contains the plugin policy, discovery interface, skill and product workflows.

## Hosting

No server hosting is required for the current plugin. An MCP client on the user's
computer starts the plugin locally; that process connects to Infomaniak's API
using the user's configured credentials.

A future remote MCP service can run on Infomaniak for browser-based clients and
shared access. Self-hosted instances and a managed multi-user service are separate
deployment choices. They need authenticated HTTPS, isolated credentials and
operation state, and an approval interface before remote writes can be enabled.
The current stdio server does not provide those features.

Local and remote operation should share the same API catalogue and safety policy.
Hosting the gateway on Infomaniak does not determine where the AI client processes
the results it receives. See [the architecture](docs/architecture.md).

## Three tools

| Tool                | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `infomaniak_status` | Show the configured adapter and available reviewed reads      |
| `infomaniak_search` | Find relevant operations and load their schemas on demand     |
| `infomaniak_read`   | Call an allowed read; reject writes and generic API execution |

Example conversation: "Find my Infomaniak accounts, inspect the domains in the
account I select, and explain what is missing before I can deploy this app."

Availability depends on the selected adapter build. Original upstream builds lack
the new DNS reads and token-only VPS support. The plugin reports those gaps. It
does not infer live API permission from the presence of a tool.

## Local setup

Requires Node.js 20+ and a separately built, reviewed `infomaniak-mcp-agent`.
No upstream npm version is assumed: `0.15.2` returned 404 during validation.

```sh
npm ci --ignore-scripts
npm test
```

Configure these values in the AI client's configuration/secret store or environment:

- `INFOMANIAK_API_TOKEN`: a token with the necessary read access.
- `INFOMANIAK_MCP_SERVER_PATH`: absolute path to the reviewed adapter's `dist/server.js`.
- `INFOMANIAK_MCP_SHA256`: SHA-256 of that exact file. On macOS, obtain it with
  `shasum -a 256 /absolute/path/to/infomaniak-mcp-agent/dist/server.js`.

For generic MCP clients, the server command is `node` and its argument is the
absolute path to this plugin's `dist/server.js`. Pass the three environment values
through the client's configuration. Do not paste credentials into a conversation.

For Claude Code, after building the plugin:

```sh
claude plugin validate .
claude --plugin-dir .
```

The manifest prompts for the reviewed adapter file, checksum and token. The token
field is marked sensitive for the client's secure storage. These settings use the
[Claude Code plugin manifest](https://code.claude.com/docs/en/plugins-reference).
Other hosts use the same MCP server; their native installation UI is not tested yet.

With the environment already configured, run this local check:

```sh
npm run doctor
```

Doctor checks configuration and file integrity; it makes no API requests and does
not prove token scopes. Status connects to the adapter and reads its catalogue.

## Runtime boundary

- A fixed reviewed-operation allowlist is enforced before a call is forwarded.
  The model cannot supply an API path, method, shell command or confirmation token
  to gain write access. Read-only hints alone do not admit an operation.
- The reviewed adapter runs with Manager browser auth disabled and
  `INFOMANIAK_READ_ONLY=1`. A preloaded fetch guard independently rejects non-GET
  requests, non-public-API origins and redirects.
- Child configuration contains the API token and fixed adapter controls; the SDK
  also inherits its small OS-environment allowlist. Unrelated provider credentials
  and browser session variables are not forwarded.
- Configured token strings and common credential fields are redacted from results.
  Responses are bounded; oversize results fail instead of being silently truncated.
- The backend file must match its checksum on connection. Do not select arbitrary
  scripts. The fetch guard is for the reviewed adapter, not an OS sandbox for an
  untrusted Node process, and the checksum does not verify its whole dependency tree.
- The gateway controls its own tools. It cannot make another shell/MCP tool in the
  host read-only, and it does not implement multi-user tenant isolation.

For future writes, approval must be outside the model-controlled request, bound to
the exact account/resources/change, and followed by readback and failure recovery.
Full catalogue discovery will not automatically enable new operations. Secrets,
external messages, purchases, deletion and service disruption need explicit policy
beyond ordinary inventory reads.

## Development

```sh
npm run typecheck
npm test
```

Fixture tests use fake MCP servers and documentation values. Live checks are kept
outside the repository. This package is private to prevent accidental publication.
There is no telemetry, background maintenance, credential persistence or automatic
client configuration.

MIT licensed. The MCP adapter is a separate project with its own license and authors.
