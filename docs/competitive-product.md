# Closing the product gap

Checked 28 October 2026 against the vendors' current documentation. The priorities
below are a product recommendation, not a claim of parity or completed work.

Vercel exposes projects, deployment/build/runtime logs and a deployment workflow.
Cloudflare exposes API search, execution and documentation through a compact tool
interface, plus agent-specific setup guides and skills. Both use authorisation;
neither benchmark establishes that every tool runs without confirmation.

Sources: [Vercel tools](https://vercel.com/docs/agent-resources/vercel-mcp/tools),
[Vercel setup](https://vercel.com/docs/agent-resources/vercel-mcp),
[Cloudflare MCP](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/),
[Cloudflare agent setup](https://developers.cloudflare.com/agent-setup/).

## Current position

Our shared endpoint has a working OAuth connection, encrypted tenant credentials,
account/product inventory, progressive API discovery and a verified disposable
TXT write cycle. New client registrations now offer supported writes by default.
Existing read-only grants remain unchanged. The runtime still limits hosted writes
to `_infomaniak-ai-test` in one consented domain. It is a foundation, not a general
Infomaniak control plane. The 1,514 catalogue entries are not executable coverage.

## Ship in this order

| Deliverable                  | User task                                                                                                                                       | Release proof                                                                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Useful hosted DNS            | “Point staging.example.com at this server.” Resolve account/domain names, inspect records, plan A/AAAA/CNAME/TXT changes and return the result. | Tenant-bound reads/writes, exact before/after, provider readback, propagation check, and an explicit recovery plan. Live mutation tests use an authorised disposable target. |
| Mail administration          | “Add this alias to the support mailbox.” Bring the reviewed alias and forwarding handlers into hosted resource consent.                         | Correct hosting/mailbox resolution, recipient disclosure, provider permissions and disposable live qualification. Message content and sending are separate capabilities.     |
| VPS diagnosis and deployment | “Deploy this repository to my Infomaniak VPS and attach the domain.” Distinguish provider inventory from guest access.                          | A customer-owned scoped runner, logs, TLS, health and a tested previous-release recovery path. No arbitrary shell tool or shared custody of customers' root keys.            |
| Native onboarding            | Install from Claude Code, Codex, Cursor, VS Code and compatible web clients.                                                                    | Record a fresh-account native connection, inventory result, write review and disconnect for each supported client. Standard SDK tests do not substitute for this.            |
| Infomaniak context           | Resolve names to IDs, explain token/product permissions and retrieve relevant operation schemas and provider documentation.                     | Each discovered operation says executable or unavailable, required access, applicable product and validation status. Search results remain small.                            |
| Daily operations             | Inspect connection scope, recent changes, failures and recovery from one private page.                                                          | Tenant-only history, stable errors with a next action, no credentials in traces, and useful feedback/reporting that users explicitly send.                                   |

The next release should complete the DNS workflow rather than adding more catalogue
counts or visual decoration. Promote broader permissions only alongside implemented
handlers, tenant checks and accurate capabilities. Keep ordinary writes easy to
reach; place stronger review on destructive, mail-routing, credential and billing
operations. The current per-plan review can become more selective after operation
classes have their own tested policies.
