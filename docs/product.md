# Infomaniak AI

Working name. Independent, unofficial open-source plugin. Reuse
[infomaniak-mcp-agent](https://github.com/Mogacode-ma/infomaniak-mcp-agent) as an
adapter; keep provider fixes upstream and product workflows here.

## Product promise

Let a developer ship and operate an application on Infomaniak from their AI
assistant: understand the project, choose a suitable target, produce a deployment
plan, obtain approval, publish a preview, connect the domain, diagnose failures and
restore the previous release. Every claimed result should have observable evidence.

The initial user is a developer or small agency already using Infomaniak for
hosting, domains, mail or VPS. They should not need to learn provider IDs and
private API routes to complete a task. The current tools expose resources, but
do not yet provide a consistent application/release workflow.

## What to learn from the benchmarks

| Benchmark                | Useful pattern                                                     | Application here                                                                                 |
| ------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Vercel MCP               | Project/deployment/log workflows and permission-aware availability | Bind operations to one project, target and environment; show what the connection can actually do |
| Cloudflare agent tooling | Skills, documentation and progressive capability discovery         | Three stable gateway tools; reveal the relevant operation schemas when requested                 |
| Infomaniak               | Existing hosting, DNS, mail and compute products                   | Map those products honestly to supported workflows, with adapters per product                    |

These are product design inferences, not claims of feature parity. A plugin does
not supply a global edge network or replace the hosting platform's runtime.

Sources checked 20 October 2026:

- [Vercel MCP tools](https://vercel.com/docs/agent-resources/vercel-mcp/tools)
- [Cloudflare docs for agents](https://developers.cloudflare.com/docs-for-agents/)
- [Cloudflare progressive discovery / Code Mode](https://developers.cloudflare.com/agents/tools/codemode/)
- [Infomaniak Node.js hosting](https://www.infomaniak.com/en/hosting/nodejs-hosting)
- [Claude Code plugin manifest](https://code.claude.com/docs/en/plugins-reference)

## First-release goals

Targets below are acceptance criteria, not measured results:

1. A configured developer identifies accessible accounts and relevant resources
   in under five minutes, without a browser session.
2. The initial MCP interface always has three tools. Available read schemas load
   on demand; absent capabilities are reported explicitly.
3. Every rejected mutation is blocked before forwarding a tool call. The reviewed
   adapter's fetch transport also rejects non-GET requests and redirects.
4. A clean install can run fixture tests without credentials or a live account.
5. A supported existing application can eventually reach a verified preview URL
   from a repository, then survive a tested rollback. This is the next release
   gate, not a capability of the foundation.

## User stories

- As an Infomaniak customer, I can identify the correct account and distinguish
  a web hosting from a VPS or Public Cloud project before choosing a target.
- As a developer, I can ask which operations work through this exact adapter
  build, rather than receive a plan based on unavailable provider features.
- As an agency developer, I can bind a deployment to a project and environment
  so that a preview cannot overwrite a production domain.
- As an operator, I can distinguish provider state, application health, an
  incomplete observation and an unsuccessful operation.
- As a maintainer, I can update the provider adapter independently of the plugin
  and detect incompatible schemas before releasing it.

## P0: foundation, implemented first

- A standalone MCP stdio gateway with `infomaniak_status`, `infomaniak_search`
  and `infomaniak_read`.
- A fixed allowlist of reviewed reads. Tool hints, names suggested by the model,
  and confirmation tokens cannot grant write access.
- Explicit account IDs for account-scoped listings; never silently select the
  first account. Provider credentials still define actual resource permissions.
- A checksum-verified, explicitly selected local backend executable, with browser
  authentication disabled and a narrow child environment.
- Output redaction, bounded responses, bounded catalogue pagination and clear
  errors for missing operations. Availability is advertised, not proof of scopes.
- A portable skill, a native Claude Code plugin manifest, and generic MCP launch
  instructions. No global client settings modified during development.

## P1: one complete application workflow

Choose one release engine after a disposable test target is available. Managed
Node.js hosting is a native option if its authentication and release semantics can
be verified. For VPS hosting, evaluate an existing engine such as Coolify before
building a scheduler, image registry or deployment controller ourselves. The plugin
should coordinate a documented deployment API, not expose arbitrary SSH commands.

Coolify documents queued deployments, separate preview environments and preview
API reads/writes. That makes it a plausible VPS adapter, not a verified integration.
Do not install it on an existing server without reviewing capacity, port conflicts,
recovery and the user's intended changes. Dokploy is another candidate; support
one engine first rather than implementing both speculatively.

- [Coolify deployment model](https://coolify.io/docs/applications/deployments/overview)
- [Coolify preview API and lifecycle](https://coolify.io/docs/applications/deployments/preview-deployments)
- [Dokploy previews](https://docs.dokploy.com/docs/core/applications/preview-deployments)

Deliver one vertical slice before adding more product families:

1. Inspect repository metadata without executing project code.
2. Bind `.infomaniak/project.json` to explicit account, application and environment.
3. Check framework/runtime compatibility and build requirements. Detect
   Vercel/Cloudflare-specific dependencies rather than promising portability.
4. Show exact resource changes, cost implications and a restoration plan.
5. Get approval through the host UI, outside the model's own tool arguments.
6. Build an immutable release and deploy to a separate preview hostname.
7. Check build outcome, HTTP response, DNS and TLS; return evidence or failure.
8. Promote only the approved release; restore the previously verified release.

Acceptance: a disposable application completes this loop and a failed deployment
leaves production unchanged. Timeouts enter an unknown-outcome state until readback
reconciles them; mutations are never blindly replayed.

## P2: operate and distribute

- Project-scoped logs, deploy history, runtime errors, health and drift.
- Secret references and environment-key management without exposing secret values.
- A durable operation journal, cancellation, resumable polling and idempotency
  where the provider supports it.
- Multi-project environments, team policy and protected production approvals.
- Public Cloud/container adapters and optional constrained VPS runners.
- Signed/pinned distributions, compatibility matrix, clean-machine installation
  tests and client-specific onboarding. Remote multi-user MCP requires a separate
  authentication and tenant-isolation design.

## Scope limits

The foundation has no deployment, promotion, rollback, arbitrary API execution,
shell/SSH execution or billing actions. It does not expose credential-returning
routes. A plan is not an execution, and a two-phase token returned to the model is
not independent human approval. Infrastructure changes need a later runtime gate.

## Blocking questions and evidence

- Engineering: which supported authentication path permits unattended application
  deployment? The current adapter uses Manager sessions for several hosting actions.
- Provider/API: what preview, immutable-release and rollback primitives exist on
  the chosen product? They have not been established for this plugin.
- Product: the first test application and disposable hosting target are still to
  be selected. Existing live services are not disposable by default.
- Distribution: npm returned 404 for upstream `0.15.2` on 20 October 2026 despite
  the repository carrying that version. The prototype requires a local audited
  build; it must not invent a working package-install command.

Ship the foundation first, prove one preview/rollback workflow next, then expand
operations and distribution. No fixed calendar promise until the deployment
adapter and test environment are validated.
