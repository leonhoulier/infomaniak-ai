# Infomaniak AI

An independent, unofficial AI plugin for Infomaniak. Discover services, inspect
resources, review an exact change, approve it independently, execute and verify.

Version 0.2 has a local MCP server, an optional authenticated HTTP service, a
human approval interface and a durable operation journal. The complete public
catalogue is searchable; execution is limited to reviewed handlers.

| Coverage                                      | Current state                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| Public catalogue                              | 1,514 method/path pairs across 15 product groups                            |
| Pinned public schemas                         | 16 selected operation definitions                                           |
| Reviewed operations                           | 9 reads, 8 writes; VPS reads require the existing MCP adapter               |
| Writes                                        | Disabled on initialization; scoped grants and independent approval required |
| Application deployment / VPS lifecycle writes | Not implemented                                                             |
| Live compatibility                            | Read evidence exists; live write qualification is pending                   |

Catalogue discovery is not proof that an operation is implemented or permitted.
See [coverage and safety](docs/api-coverage.md), [validation](docs/validation.md)
and the [remaining roadmap](docs/product.md).

## Public installation

Every customer uses their own credentials. With only `INFOMANIAK_API_TOKEN` (or
its private `_FILE` source), the server starts a read-only discovery edition:
accounts, products and the full public catalogue. No author account, backend,
private policy or server hosting is needed for that starting point. It exposes
four tools and cannot plan or execute writes.

A scoped policy enables resource-level reads and the controlled write lifecycle.
The original backend configuration remains supported separately.

## Local setup

Requires Node.js 22.13+; the controlled edition uses Node's SQLite API.
No server hosting is required.

```sh
npm ci --ignore-scripts
npm test
```

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

The policy-driven edition exposes eight tools:

| Tool                   | Purpose                                             |
| ---------------------- | --------------------------------------------------- |
| `infomaniak_status`    | Coverage, configured adapters and connection policy |
| `infomaniak_search`    | Relevant operations and reviewed schemas on demand  |
| `infomaniak_catalogue` | Paginated public metadata by product/method         |
| `infomaniak_read`      | A reviewed read within account/resource grants      |
| `infomaniak_plan`      | Persist a preview; no provider mutation or approval |
| `infomaniak_execute`   | Execute an independently approved exact plan once   |
| `infomaniak_operation` | Status or read-only reconciliation                  |
| `infomaniak_cancel`    | Cancel before execution starts                      |

There is no MCP approval tool or generic HTTP/shell executor. Search can return
disabled catalogue entries with the reason they cannot execute.

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
