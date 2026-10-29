# Infomaniak MCP

Use your AI coding tools with the Infomaniak services you already run.
Independent, unofficial and open source. Built by [Léon Houlier](https://leonhoulier.com).

**[Try the hosted pilot](https://infomaniak-mcp.com)** ·
[Plugin downloads](https://infomaniak-mcp.com/plugins) ·
[Contribute](CONTRIBUTING.md) ·
[API reference](https://infomaniak-mcp.com/api) ·
[Privacy](https://infomaniak-mcp.com/privacy) ·
[Cookie policy](https://infomaniak-mcp.com/cookies)

```text
https://infomaniak-mcp.com/mcp
```

For Claude Code:

```sh
claude mcp add --transport http infomaniak https://infomaniak-mcp.com/mcp
```

Then run `/mcp` in Claude Code and complete browser sign-in. For other clients,
use the [setup guides](https://infomaniak-mcp.com/#setup). Each customer enters
their own Infomaniak token on a private page and approves one account. Never
paste a token into chat or a GitHub issue. Native client onboarding is still
being qualified.

Ask: **“Show my Infomaniak services.”**

| Capability             | Hosted service today                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery              | Approved account/product inventory and resource-name resolution                                                                        |
| DNS                    | Records, audit, propagation and expiry; record create/update/delete in consented domains                                               |
| Mail                   | Consented mailbox metadata, aliases and forwarding; supported settings changes                                                         |
| VPS apps               | Customer-owned runner, pinned stateless Dockerfile deployment, health, requested logs and retained-image rollback                      |
| Official documentation | Live help search in seven languages, live developer index, current guides and API references                                           |
| Changes                | Read/write offered during setup; read-only available; each exact write needs client confirmation when supported, with browser fallback |

The service does not expose mailbox content, generic HTTP execution, arbitrary
shell commands, purchasing or general VPS lifecycle writes. Catalogue metadata
is documentation, not executable coverage. Provider tokens are encrypted at
rest; the operator holds the encryption key and can use them for API requests.

Not affiliated with or endorsed by Infomaniak.

## Hosted connection

Use `https://infomaniak-mcp.com/mcp` with the client's OAuth flow. Every customer
connects their own Infomaniak token privately, chooses an account and selects
resources. Customers do not need a local runtime or their own server. An optional
VPS deployment needs a paired customer-owned runner. Existing grants never
expand automatically; explicit read-only remains authoritative.

See the [API and current capabilities](https://infomaniak-mcp.com/api),
[client qualification evidence](https://infomaniak-mcp.com/clients) and
[privacy policy](https://infomaniak-mcp.com/privacy). Native client qualification
varies; an endpoint or local test pass is not proof of every client workflow.

The hosted service, plugin packages and runner are released from this source.
See [versioned releases](https://github.com/leonhoulier/infomaniak-ai/releases)
for the source, plugin ZIPs and checksums. The runner is also available at
[Downloads](https://infomaniak-mcp.com/downloads).

## Hosted plugin package

A thin hosted plugin lives under [plugins/infomaniak](plugins/infomaniak/README.md).
It bundles private connection guidance and reusable Infomaniak workflows with
the existing remote MCP. Portable Agent Plugins manifests target compatible
hosts, with a Claude compatibility package alongside them. No provider token is
stored in the plugin package.

Download the [public plugin packages](https://infomaniak-mcp.com/plugins), or
build them with `node scripts/package-plugin.mjs`. Claude Code can install from
this repository:

```sh
claude plugin marketplace add leonhoulier/infomaniak-ai
claude plugin install infomaniak@infomaniak-mcp
```

Version 0.3.5 is [published in the MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.leonhoulier%2Finfomaniak-mcp/versions/0.3.5).
The entry points to the hosted OAuth endpoint; customers do not need an npm
package. Claude is submitted for review, Cursor has received the publisher application, and OpenAI has an uploaded draft. These are not approved directory listings.
Repository installation and public downloads are available separately. See the
[distribution plan](docs/distribution.md) for current submission routes, native
qualification, review materials and discovery priorities.

To try the browser experience privately, run `npm run preview` and open
`http://127.0.0.1:8790`. It uses demo data by default. See
[testing the hosted experience](docs/testing.md).

## Local installation alternative

Every customer uses their own credentials. With only `INFOMANIAK_API_TOKEN` (or
its private `_FILE` source), the server starts a read-only discovery edition:
accounts, products and the full public catalogue. No author account, backend,
private policy or server hosting is needed for that starting point. It exposes
six tools and cannot plan or execute writes.

A scoped policy enables resource-level reads and the controlled write lifecycle.
The original backend configuration remains supported separately.

## Connect your AI client

Requires Node.js 22.13+. No server hosting is required. From this checkout:

```sh
npm ci --ignore-scripts
npm run build
node dist/server.js setup
```

Choose your client. Claude Code and Claude Desktop use their private plugin
settings; VS Code uses a native password prompt. Codex and Cursor use hidden
terminal entry with a private local credential file, outside your project.
Setup explains where your token goes before asking for it. Never paste it into chat.

For Claude Desktop, build the extension with `npm run package:desktop`, then open
`artifacts/infomaniak-ai-0.2.0.mcpb`. Dependencies are included; the bundle is
unsigned and native installation still needs client validation.

Your first question:

> Show my Infomaniak services. If I have several accounts, let me choose one.

Preview any connection with `node dist/server.js setup --client vscode --dry-run`.
See [the onboarding guide](docs/onboarding.md) for each client, token permissions,
rotation and removal. No npm or marketplace release is available yet.

## JSON write API

The JSON API exposes scoped reads and plan, execute, cancel and reconciliation
routes. The hosted beta limits writes to a disposable TXT name and uses encrypted
plans with native client confirmation when form elicitation is negotiated, or browser approval otherwise. The separate policy edition retains its configured
resource grants and human key. There is no API approval endpoint. See [the write API reference](docs/write-api.md).

## Advanced: scoped reads and independently approved writes

The simple connection above provides account and product discovery. To inspect
individual resources or enable reviewed changes, configure a separate scoped
policy. The controlled edition uses Node's SQLite API.

Initialize a **new private directory** using your actual account ID. Replace the
capitalized placeholders; omit product options you do not need:

```sh
node dist/admin.js init \
  --directory "$HOME/.config/infomaniak-ai" \
  --account ACCOUNT_ID \
  --zone example.com \
  --dns-source _infomaniak-ai-test \
  --mail-hosting MAIL_HOSTING_ID \
  --mailbox MAILBOX_NAME
```

This writes a private policy, a client connection token and a separate human
approval key. Their values are never printed. All writes and writable resource
grants start disabled. Existing installations are never overwritten.

Configure the provider token in the client's secret store or in
`INFOMANIAK_API_TOKEN`. Alternatively set `INFOMANIAK_API_TOKEN_FILE` to an
absolute regular secret-file path with mode 0600. Do not configure both sources,
or paste credentials into a conversation.

For a generic MCP client, use command `node` with arguments:

```text
/absolute/path/to/infomaniak-ai/dist/server.js
--config
/absolute/path/to/private/access.local.json
```

The default local policy also starts the approval interface at
[localhost:8787/approvals](http://localhost:8787/approvals). Its human key belongs
in the browser/interactive human terminal, outside the AI client's configuration.

```sh
node dist/server.js --config /absolute/path/to/access.local.json --doctor
```

Doctor checks configuration and optional backend integrity, without provider calls.

## Tools

The policy-driven edition exposes ten tools:

| Tool                     | Purpose                                             |
| ------------------------ | --------------------------------------------------- |
| `infomaniak_status`      | Coverage, configured adapters and connection policy |
| `infomaniak_search`      | Relevant operations and reviewed schemas on demand  |
| `infomaniak_catalogue`   | Paginated public metadata by product/method         |
| `infomaniak_read`        | A reviewed read within account/resource grants      |
| `infomaniak_plan`        | Persist a preview; no provider mutation or approval |
| `infomaniak_execute`     | Execute an independently approved exact plan once   |
| `infomaniak_operation`   | Status or read-only reconciliation                  |
| `infomaniak_cancel`      | Cancel before execution starts                      |
| `infomaniak_docs_search` | Current official help guides or live API index      |
| `infomaniak_docs_read`   | Fetch a current official guide or API reference     |

There is no MCP approval tool or generic HTTP/shell executor. Search can return
disabled catalogue entries with the reason they cannot execute.

Reviewed operations carry Infomaniak-specific `notes` in search results: which
ID is which, the `.` zone apex, MX priority inside the target, UTC expiry dates,
what the forwarding flags mean. The [skill](skills/infomaniak/SKILL.md) has the
full table.

### Current documentation and browser tasks

Every edition includes live official documentation search and reading. Use
`infomaniak_docs_search` with public topic terms (for example, `VPS Lite SSH`),
then `infomaniak_docs_read` with a returned URL. Set `source: "api"` to search
the live developer index rather than the bundled operation catalogue.
Results include source URLs, retrieval times and explicit pagination.

When an API capability is missing, agents can follow the official Manager guide
using their own authorized browser or computer tools. Documentation access does
not control a browser or grant permission to change resources. See
[documentation access](docs/documentation.md).

### Read-only diagnostics

| Operation         | What it checks                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `domains.expiry`  | Registration expiry in UTC, days left, expired/expiring/ok                                                 |
| `dns.audit`       | SPF (missing, duplicate, `+all`, Infomaniak include), DMARC, DKIM delegation, MX, apex CNAME, low TTLs     |
| `dns.propagation` | Google, Cloudflare and Quad9 answers for one name, compared with the zone; a failed lookup is disagreement |

They read the stored zone and public resolvers. They are not mail delivery or
signing tests.

## Controlled writes

Start with explicitly disposable resources. An operator must grant all of:

1. The exact reviewed operation in the principal's `operations` list.
2. `writes: "disposable-only"` and an exact resource binding with
   `disposable: true` and `writable: true`.
3. A fresh independent human approval of the complete plan.

Named DNS grants use `resources.dns_names["example.com:_infomaniak-ai-test"]`.
Update/delete calls include `expected_source` when using such a narrow grant.
A writable whole-zone grant permits broader changes; a zone inventory grant
does not. Mailbox grants use `resources.mailboxes["HOSTING_ID:MAILBOX_NAME"]`,
separate from mail-hosting inventory grants.

A human reviews account, resource, before/after values, impact and recovery limits
at `/approvals`, then types APPROVE. The model receives a plan ID/hash; neither
can grant approval. Local administrators can also use `admin.js plans`, `show`
and interactive `approve` with the separate human key.

Stale or expired plans cannot execute. Conflicting writes serialize through
resource locks. Uncertain requests remain locked and reconcile through reads;
mutations are never automatically retried. A verified provider state does not
prove DNS propagation, delivery, SSH reachability or application health.

To qualify writes on your own account, pick a zone and a throwaway mailbox.
Supply `INFOMANIAK_API_TOKEN` through a private terminal environment first; never
include its value in the command or shell history. Then run:

```sh
node scripts/qualify-writes.mjs \
  --account ACCOUNT_ID --zone example.com --mail-hosting MAIL_HOSTING_ID --mailbox throwaway
```

It only touches the DNS name `_infomaniak-ai-test` and the alias `ik-ai-test`,
plans each change, waits for you to approve it with `node dist/admin.js approve`
in a second terminal, then executes, reads back and finally checks that the zone
and aliases match their starting state. It never approves anything itself.

Use `writes: "enabled"` only after disposable live qualification and a deliberate
policy review. It still requires writable resource grants, operation grants and
per-plan independent approval. Credentials, purchases, arbitrary API execution,
VPS reinstall and other unreviewed operations remain unavailable.

## Existing MCP reuse and compatibility

The original three-tool read-only edition remains available without a policy file.
It requires `INFOMANIAK_API_TOKEN`, `INFOMANIAK_MCP_SERVER_PATH` (absolute reviewed
`dist/server.js`) and `INFOMANIAK_MCP_SHA256`. It runs the backend with browser
auth disabled and a GET-only fetch guard.

The controlled edition can reuse that adapter for token-only VPS reads via:

```json
{
  "backend": {
    "path": "/absolute/path/to/infomaniak-mcp-agent/dist/server.js",
    "sha256": "SHA256_OF_REVIEWED_ENTRY_FILE"
  }
}
```

This is a policy fragment, not a complete configuration. The checksum covers the
entry file, not its dependency graph. Use an audited build; a guard is not an OS
sandbox for an untrusted executable. The reviewed VPS companion capability is
required. Upstream npm 0.15.2 returned 404 during the earlier validation, so no
working upstream package-install command is assumed.

For Claude Code:

```sh
claude plugin validate .
claude --plugin-dir .
```

Select the optional private policy file for the controlled edition, or supply the
reviewed backend path/checksum for the original edition. Manifest validation is
separate from native-client onboarding, which has not been proven end to end.

## Related projects

This plugin grew out of contributions to two existing open-source projects, and
reuses what was learned there:

- [peaktwilight/infomaniak-cli](https://github.com/peaktwilight/infomaniak-cli),
  a Python CLI for the Infomaniak API. Open pull requests add DNS propagation and
  sync fixes, a DNS audit fix, hosting discovery, read-only mode, `--dry-run`
  previews and mailbox commands.
- [Mogacode-ma/infomaniak-mcp-agent](https://github.com/Mogacode-ma/infomaniak-mcp-agent),
  a TypeScript MCP server with two-phase confirmation. Open pull requests add DNS
  export/diff/propagation tools, token-only VPS inventory and firewall reads,
  tests, read-only mode, alias deletion and mailbox forwarding.

Use the CLI for scripting, the MCP server for a broad tool surface driven by an
agent, and this plugin when you want scoped grants and approval by a separate
human for every write.

## Optional hosting on Infomaniak

The authenticated Streamable HTTP edition uses separate application-specific
client and human-approval credentials, plus an isolated provider token per user.
Run `node dist/server.js --config /private/access.local.json --http`.

See [the Infomaniak VPS deployment guide](docs/hosting.md) for the pinned Docker
image recipe, Caddy HTTPS proxy, private state, backup and restart procedure.
Nothing is deployed by building this repository. OAuth-only client onboarding
and a public managed service remain future work.

## Build a distributable bundle

```sh
npm run package
```

This creates `artifacts/infomaniak-ai-0.2.0.tgz` with compiled code, catalogue,
skill and plugin manifest. A whitelist excludes tests, local policies, credentials
and operation databases. The package remains marked private during development
to prevent accidental registry publication; the local bundle is installable.
A public registry/marketplace release has not occurred.

To test the bundle in a separate local installation:

```sh
npm install --prefix "$HOME/.local/share/infomaniak-ai" \
  --ignore-scripts ./artifacts/infomaniak-ai-0.2.0.tgz
```

Configure the MCP client's command as `node`, with the installed absolute
`node_modules/infomaniak-ai/dist/server.js` path as its argument and your provider
token in its secret environment. With no policy or backend configuration, this
starts the four-tool discovery edition. Run `python3 scripts/bundle-smoke.py` to
check the bundle in a disposable clean Node container using fake credentials.

## Development

Contributions are welcome: Infomaniak operations, client compatibility, docs and
regression tests. Read [CONTRIBUTING.md](CONTRIBUTING.md), open an issue for a
larger change, or send a small pull request. Report vulnerabilities privately
using [SECURITY.md](SECURITY.md).

```sh
npm run typecheck
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
npm run format:check
```

Fixture tests use fake credentials and APIs. The container smoke test disables
networking and uses a disposable state directory. Live evidence stays outside
this repository. This package is private to prevent accidental publication.

MIT licensed. Provider adapter fixes remain separate upstream contributions.
