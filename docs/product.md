# Infomaniak AI

Working name. Independent, unofficial open-source plugin. Reuse
[infomaniak-mcp-agent](https://github.com/Mogacode-ma/infomaniak-mcp-agent) as an
adapter; keep provider fixes upstream and product workflows here.

## Product promise

Let an Infomaniak customer understand and operate their services through an AI
assistant, with broad read and write coverage and understandable control over
changes. Discover the capability, inspect the selected resources, preview the
change, approve it, execute it and verify the outcome.

The target is all supported, accessible Infomaniak API operations, including
domains/DNS, mail, hosting and compute, collaboration, storage, media and account
administration. Application deployment is one workflow within that product.
Coverage must distinguish documented routes, implemented operations, actual
permissions and verified behavior. No promise that every Manager feature has a
supported public API, or that all products share one credential type.

The initial user is a customer or small agency already using Infomaniak for
domains, mail or VPS. They should not need to learn provider IDs or private API
routes to complete a task. Safety must be enforced by the runtime as well as
explained by the assistant.

## Hosting choices

The local plugin needs no hosted service. Each user's MCP client launches it on
their computer and supplies that user's credentials. This remains a supported
installation mode as the product grows.

Offer a remote MCP service on Infomaniak when browser-based clients or shared
access justify it. Start with an isolated single-owner instance on a suitable VPS;
size it from measured load. Multi-user hosting is a later, separate release gate:
it requires authenticated HTTPS, per-user credential isolation, authorization,
durable operations and independently authenticated approval. An HTTP wrapper
around today's stdio process is insufficient.

Use the same catalogue, operation contracts and safety rules in both modes. A
managed service must never use the operator's own Infomaniak token for customers.
An Infomaniak-hosted gateway does not control the AI client's own data processing.

## What to learn from the benchmarks

| Benchmark                | Useful pattern                                             | Application here                                                       |
| ------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| Vercel MCP               | Resource workflows and permission-aware availability       | Report what this connection can actually do for the selected resources |
| Cloudflare agent tooling | Skills, documentation and progressive capability discovery | Load relevant operation schemas on demand across a broad catalogue     |
| Infomaniak               | Multiple API products and authentication systems           | Keep product boundaries, scope requirements and evidence explicit      |

These are product design inferences, not claims of feature parity. A plugin does
not supply a global edge network or replace the hosting platform's runtime.

Sources checked 20 October 2026:

- [Vercel MCP tools](https://vercel.com/docs/agent-resources/vercel-mcp/tools)
- [Cloudflare docs for agents](https://developers.cloudflare.com/docs-for-agents/)
- [Infomaniak API catalogue](https://developer.infomaniak.com/docs/api)
- [Infomaniak API overview and restrictions](https://www.infomaniak.com/en/support/faq/2581/discover-the-infomaniak-api)
- [Infomaniak API tokens](https://www.infomaniak.com/en/support/faq/2582/add-and-manage-infomaniak-api-tokens)
- [Infomaniak Public Cloud identity](https://docs.infomaniak.cloud/identity/)
- [MCP local and remote transports](https://ts.sdk.modelcontextprotocol.io/client)

## Acceptance goals

Targets below are acceptance criteria, not measured results:

1. A configured user identifies accessible accounts and relevant resources in
   under five minutes, without a Manager browser session.
2. Every catalogued operation reports its implementation, policy, authentication
   requirements and validation status. Search returns a small relevant selection.
3. A model cannot grant itself access, select another user's credentials, or
   approve its own mutation. All new catalogue entries start disabled.
4. Every enabled write has a preview, appropriate approval, bounded execution,
   recorded outcome and verification. Unknown outcomes require reconciliation.
5. Fixture tests run without credentials. Mutating live tests use explicitly
   designated disposable targets; lack of a test product remains visible.
6. Users can install locally without operating a server. Remote clients receive
   equivalent policy protection when a hosted edition is released.

## User stories

- As a customer, I can identify the correct account and distinguish VPS Lite,
  managed hosting and Public Cloud before choosing a resource.
- As an operator, I can inspect resources across products and see unavailable
  operations and missing access without the assistant guessing API paths.
- As a customer changing DNS or mail, I can review the exact before/after values,
  affected resources, risks and recovery options before approving execution.
- As an agency, I can restrict a connection to selected accounts and resources,
  with stronger protection for production and customer-visible actions.
- As a maintainer, I can update API schemas and provider adapters independently,
  review coverage changes and detect incompatible behavior before release.

## P0: foundation, implemented

- Local MCP stdio gateway with `infomaniak_status`, `infomaniak_search` and
  `infomaniak_read`.
- Fixed allowlist of reviewed reads; hints and model-visible confirmation tokens
  cannot grant write access. A GET-only fetch guard protects the reviewed adapter.
- Explicit accounts for account-scoped listings, a selected/checksummed backend,
  Manager browser auth disabled, narrow child environment and bounded responses.
- Output redaction, clear missing-operation errors, portable skill and a native
  Claude Code plugin manifest. No global client settings changed.

This is a read-only foundation, not the completed broad-coverage product.

## P1: catalogue and controlled execution

Build the [API coverage registry and write policy](api-coverage.md) first. Import
public operation metadata and available schemas with versioned provenance;
track reviewed additions and removals. Discoverability does not grant execution.
Keep separately documented service APIs, undocumented routes and Manager-only
behavior visible as separate categories.

Keep a small MCP interface as the catalogue grows. Future planning, execution
and operation-status tools can join the existing three tools; do not expose
thousands of eagerly loaded tool definitions or arbitrary HTTP/JavaScript.

Implement one shared write lifecycle: plan, independent approval, execution,
readback and outcome journal. Approval binds the exact account, resources,
arguments, operation version, expiry and observed preconditions. Sensitive
reads and external messages also need appropriate consent.

Acceptance: in an isolated fixture environment, attempted self-approval,
cross-account access, stale plans, replayed approvals and duplicate uncertain
writes fail. A supported write completes against a disposable live target,
including readback and tested failure handling, before that operation is enabled.

## P2: expand reads and writes by product

Prioritize domains/DNS, mail and the user's VPS products, then expand through the
entire catalogue. Each product adds useful read and write operations together
once its safety and test requirements are met. Do not wait for every read in
every product before proving a bounded write.

- Reuse reviewed operations from the existing MCP. Contribute provider fixes and
  useful resource primitives upstream in small changes.
- Add typed adapters for supported APIs the existing MCP does not cover. They use
  the same registry and execution policy; no unrestricted API escape hatch.
- Keep credential-returning, destructive, costly and customer-visible operations
  discoverable but disabled until their additional controls and tests exist.
- Add cross-resource workflows after their component operations are validated:
  DNS changes, mail setup, compute management and application deployment.

VPS guest inspection through SSH is a separate capability from a provider API.
If added, use reviewed probes and constrained actions. Do not expose arbitrary
shell execution as a shortcut to missing provider operations.

Application previews and recovery need verified provider release primitives or
a typed adapter for an established release engine. Coolify and Dokploy are
candidates, not dependencies of broad API coverage or verified integrations.
Do not install a release engine on an existing server as part of API discovery.

## P3: remote access and distribution

- Infomaniak-hosted remote MCP, starting with single-owner deployment.
- Separate MCP authentication from downstream Infomaniak credentials; verify the
  product scopes available through any delegated OAuth flow before relying on it.
- Tenant isolation, per-client consent, protected approvals, encrypted credential
  storage, retention/deletion controls and tested recovery before multi-user use.
- Signed/pinned distributions, compatibility checks, clean-machine installation
  and client-specific onboarding. Preserve the local installation mode.
- Explicitly bounded automation policies for repeatable low-risk work after
  interactive writes are proven. No global approval bypass.

## Current limits and unresolved evidence

The current runtime has no writes, remote HTTP endpoint, deployment, promotion,
rollback, SSH execution or billing actions. It does not expose credential-returning
routes. Existing test results remain scoped to the foundation in
[validation.md](validation.md); the controls described for P1–P3 are planned.

- Public catalogue metadata is not a complete schema or a live test. Products
  unavailable in the test account must be marked unverified.
- Several existing hosting actions use Manager sessions. A supported unattended
  public API authentication path must be established before enabling them here.
- Delegated OAuth scopes must be tested per product; login support alone does
  not establish resource-management authorization.
- Public Cloud uses its own service APIs and application credentials. A role name
  alone does not prove a read-only boundary; verify region-specific permissions.
- Upstream npm `0.15.2` returned 404 on 20 October 2026; the foundation currently
  needs a separately built reviewed backend.
- Disposable resources and any future remote host remain to be selected. Existing
  production services are not disposable test targets.
