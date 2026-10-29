# Plugin distribution and discovery

Release 0.3.5 publishes source, plugin ZIPs and checksums on GitHub, linked from
[/plugins](https://infomaniak-mcp.com/plugins). Repository installation and public
downloads remain separate from directory review and approval.

On 29 October 2026, version 0.3.5 was published in the
[MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.leonhoulier%2Finfomaniak-mcp/versions/0.3.5).
Public API readback confirmed the entry is active and points to the hosted
endpoint. This is a metadata listing, not a client compatibility certification.
The hosted plugin also passed Claude Code's strict directory validator and a
fresh repository installation at 0.3.5. Client OAuth/write qualification and
Claude, Cursor and OpenAI portal submissions remain pending.

## Deliverable

`plugins/infomaniak/` is a thin hosted plugin: portable Agent Plugins manifests,
Claude compatibility files, a private-connection onboarding skill and an
Infomaniak operations skill. It connects to the existing OAuth MCP endpoint;
customers do not install Node, copy an API token into configuration, or host a
server. A VPS runner is needed only for the optional deployment workflow.

Build the submission ZIP with:

```sh
node scripts/package-plugin.mjs
```

The two archives in `artifacts/` are `infomaniak-plugin-portable-0.3.5.zip` and
`infomaniak-plugin-openai-0.3.5.zip`. The portable one targets compatible plugin
hosts; the OpenAI variant adds the documented OAuth/DCR submission declaration.
OpenAI documents an MCP-entry vendor extension that the current strict portable
MCP schema rejects. Keep that addition confined to the OpenAI variant; validate
it in the submission portal rather than claiming it passes the portable schema.

Each archive has an explicit file allowlist and includes no local runtime,
credentials, customer examples or operator evidence. Its root is the plugin
root, as expected by the OpenAI submission portal. Its generic icon is an
independent product mark, not Infomaniak's logo. The existing root
`.claude-plugin/plugin.json` remains the separate local-runtime alternative.
The hosted plugin's identity is `infomaniak`.

Repository marketplace catalogs are included at `.claude-plugin/marketplace.json`
and `.agents/plugins/marketplace.json`. Both point to `./plugins/infomaniak`.
The published repository is a shareable installation source. It does not create
a listing in a public directory.

## Publication routes

| Surface                  | Prepared input                                                    | Next external step                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP Registry             | `registry/server.json`; hosted Streamable HTTP, no npm package    | Published and verified active at 0.3.5 on 29 October 2026; update the listing when a new server version is released                                      |
| Claude                   | Hosted plugin ZIP and repository marketplace                      | Test a clean native plugin install, publish the marketplace files, then submit through the developer directory portal                                    |
| ChatGPT and Codex        | OpenAI submission ZIP with OAuth/DCR configuration and onboarding | Verify publisher identity, upload with MCP included, verify domain, connect a dedicated review account, resolve scans, submit and publish after approval |
| Cursor                   | Portable plugin in a public Git repository                        | Test a clean native installation and OAuth flow, then submit the repository for manual marketplace review                                                |
| Grok and other MCP hosts | Existing HTTPS endpoint and client-specific guide                 | Qualify the supported client/API; do not imply a plugin marketplace listing without a verified route                                                     |

OpenAI's current public directory is shared by ChatGPT and Codex. A custom MCP
connection, a local marketplace entry, a portal draft, approval and publication
are separate states. A declared remote URL does not itself create a public
plugin. Publisher credentials and reviewer credentials never belong in the ZIP.

For OpenAI review, prepare a dedicated account with sample resources, five
positive cases, three negative cases and an accessible walkthrough. The current
operator's live account is not a public reviewer account. Do not weaken production
authentication to make review easier. Publish only after the relevant native
workflows and review requirements have passed.

Registry namespace: `io.github.leonhoulier/infomaniak-mcp`. This is an independent
publisher namespace, not Infomaniak's official namespace. Verify availability
and publisher authentication immediately before publishing. The Registry already
contains the upstream Infomaniak MCP agent; our listing should explain the
hosted OAuth service, reviewed resource workflows and current guides accurately.

## Readiness before broad promotion

Release validation includes fixture tests, packaged-image smoke checks and live
service checks. That evidence does not qualify fresh
plugin installation or model-driven workflows in every client. Finish these:

1. Reconcile the public source, README, release assets and deployed capability
   claims. Source promotion must exclude private validation/deployment evidence.
2. Test a fresh account in each advertised client: install, OAuth, choose an
   account, inspect resources, preview a disposable change, review, execute,
   verify and disconnect. Test explicit read-only and rejected changes too.
3. Keep dependency advisories clear. The 29 October candidate uses Zod 4.6.7
   with native schema generation and updated Hono transport dependencies. Its
   production audit reports zero advisories and the regression suite passes.
   That is separate from independent security review and deployment verification.
4. Complete recovery and operator checks, then publish the exact verification
   scope and client status. Keep source checks, local packaging, native flows,
   production verification and marketplace approval distinct.

## Discovery priorities

1. **Searchable directories:** MCP Registry first, then the Claude directory,
   Cursor marketplace and OpenAI's shared directory. Each listing should use the
   same product name, publisher, canonical URL, privacy policy and supported scope.
2. **GitHub release:** current public source, a short first-run README, plugin ZIP
   and checksum, compatibility evidence, limitations and a useful issue template.
   Use accurate topics: `infomaniak`, `mcp`, `claude-code`, `codex`, `dns`, `vps`,
   `ai-agents`, `agent-plugin`. No claim of provider endorsement.
3. **Three concrete demonstrations:** inspect and change a DNS record; manage a
   disposable mailbox alias; deploy and recover a small stateless VPS app. Show
   the independent review step and actual readback, not just a successful tool call.
4. **Task pages:** explain connecting Infomaniak to each qualified client, DNS
   management, mailbox settings and VPS deployment. Include clear supported
   actions, real limits, installation links and reproducible examples. Existing
   metadata, sitemap and `llms.txt` support retrieval; they do not guarantee ranking
   or AI recommendations. Complete search-engine verification and indexing.
5. **Targeted outreach:** a release note and short demo for Infomaniak's developer
   community and relevant repositories, drafted first. Distribution work does not
   authorize unsolicited messages or marketplace submissions.

Use the positioning: **Your Infomaniak infrastructure, in your AI coding tools.**
Then show DNS, mail and VPS workflows. Competing on demonstrated outcomes gives
users more useful information than a list of unsupported API endpoints.

## Official references

- [OpenAI portable plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [OpenAI submission and review](https://developers.openai.com/plugins/deploy/submission)
- [Claude distribution and directory submission](https://code.claude.com/docs/en/plugins/publish)
- [Cursor plugin formats and submission](https://prod.cursor.com/docs/reference/plugins)
- [MCP Registry remote-server metadata](https://modelcontextprotocol.io/registry/remote-servers)
- [MCP Registry publishing](https://modelcontextprotocol.io/registry/quickstart)

## Native confirmation, 0.3.5

Hosted MCP connections negotiating form elicitation can confirm exact writes in
their client's own dialog. Account/resource consent and credential entry still
use the private browser. Clients without form support, oversized previews and
the JSON API retain the browser review. Native form support must be qualified
in the intended client; SDK fixtures and capability negotiation do not establish
that the UI is usable or that a human approved a live mutation.

The live 0.3.2 service passed fresh Claude web consent/disconnect, fresh Codex
browser/native OAuth, scoped preview/refusal/cancel/disconnect, real model status
and documentation calls, HTTPS and exact runtime-download checks. Its authorised
TXT test expired without execution. Those results remain prior-release evidence
for this candidate's changed confirmation flow.
