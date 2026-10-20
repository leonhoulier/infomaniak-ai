# Architecture

## Current local foundation

```text
AI client + portable skill
        |
        | MCP stdio: status / search / read
        v
Infomaniak AI gateway
  input validation, explicit account selection,
  reviewed read allowlist, redaction, response budgets
        |
        | MCP stdio, selected file + checksum
        v
Reviewed infomaniak-mcp-agent build
  narrow child environment, Manager auth disabled,
  preloaded GET-only fetch guard
        |
        v
Public Infomaniak API / approved DNS reads
```

The AI client launches the gateway on the user's computer. No public endpoint,
hosted account or server operated by the plugin author is required. The process
connects to Infomaniak using the configured user's credentials.

## Independent product, reusable provider adapters

The provider MCP owns resource schemas and HTTP behavior. The plugin owns
discovery, authorization policy, approval, operation state and workflows. Reuse
the existing MCP wherever it supports reviewed operations; add typed adapters
for supported API families it does not cover. Keep provider fixes upstream.

A versioned registry maps stable operation identifiers to fixed adapters, request
schemas, API versions and route templates. The model selects an operation and
supplies validated arguments; it cannot choose a server, raw path, HTTP method,
credential or arbitrary code. A catalogue import cannot enable execution.

Full coverage will need both the central REST API and separately documented
service APIs such as Public Cloud OpenStack. These have different authentication
and permission models. Browser/private Manager operations do not become public
API support because an existing adapter can call them.

## Decisions enforced today

- Local stdio only. No remote authentication service or multi-user isolation.
- Explicit backend path and checksum while a reviewed distribution is unavailable.
  The pin covers the entry file, not its full dependency graph.
- Read-only hints plus a fixed reviewed list. Original Manager-only VPS inventory
  is hidden unless the reviewed token-support companion capability is present.
- Explicit `account_id` for account-scoped listings. Child resources use explicit
  identifiers and provider resource permissions. This is not tenant isolation.
- GET-only public-origin fetch guard for the reviewed adapter, including redirects.
  It is not an OS sandbox for arbitrary Node executables or another host tool.
- No raw adapter stderr or exceptions forwarded. Configured credentials and common
  secret fields are redacted. Unknown secrets cannot be exhaustively detected.
- Bounded catalogue pagination, input and output; duplicate tools and pagination
  loops fail. Errors remain MCP errors, not success-shaped responses.

## Planned common execution core

Both local and remote editions should share:

1. A versioned coverage registry and reviewed execution manifest.
2. Principal, account, resource and environment authorization.
3. Schema validation and per-operation risk classification.
4. Exact change plans and an approval interface outside model control.
5. An executor enforcing the approved plan at the adapter/transport boundary.
6. A durable operation journal, bounded polling, readback and reconciliation.

The current backend runs with a GET-only guard. Do not remove that guard globally
to enable writes. Introduce a reviewed execution path that permits only the fixed
requests required by a particular approved operation. Binding arguments at the
gateway is insufficient if a downstream handler can make unrelated requests.
Provider multi-request workflows need a reviewed request graph and bounded effects.

Sensitive reads need data minimization and consent; HTTP method alone does not
classify risk. Resource ownership must be checked inside the gateway for future
account restrictions and remote tenants, including child IDs. Provider permissions
remain an additional boundary, not the only one.

See [API coverage and write policy](api-coverage.md) for operation metadata,
approval requirements, test gates and risk treatment. These components are design
requirements, not features implemented by the current three tools.

## Planned remote service on Infomaniak

```text
Authenticated AI client                   Authenticated human approval UI
          |                                          |
          | MCP over HTTPS                           | exact plan decision
          v                                          v
Remote Infomaniak AI service on Infomaniak
  MCP authentication / principal and resource policy
  shared execution core / operation journal
  isolated downstream credential store and workers
          |
          v
Reviewed provider adapters -> supported Infomaniak APIs
```

The first remote deployment should be an isolated single-owner instance with
TLS, process isolation, persistent state and tested recovery. A VPS is a candidate;
size and configuration follow measured workloads. Running on Infomaniak is a
hosting preference, not a claim that the remote edition is ready to deploy.

Before shared hosting:

- Authenticate MCP clients with credentials intended for this service. Keep that
  identity separate from credentials used to call downstream Infomaniak APIs.
  No acceptance of arbitrary Infomaniak bearer tokens as MCP access tokens.
- Bind each authenticated principal to permitted accounts, resources, credentials,
  journals, approvals and worker execution. No shared operator token or default
  account. Test cross-user reads, writes, caches, errors and background jobs.
- Use supported delegated authorization where validated. Otherwise enroll scoped
  downstream tokens through an authenticated secret interface, encrypted at rest,
  with revocation and deletion. Never request passwords, 2FA or Manager cookies.
- Enforce client consent, issuer/audience validation, CSRF protections, origin
  checks, safe redirects and outbound destination restrictions appropriate to the
  MCP authorization design. Verify actual product scopes before promising SSO.
- Keep secrets and complete customer payloads out of operational logs. Implement
  retention, backups and restore tests without leaking credentials into exports.
- Queue and rate-limit calls within documented provider limits. Separate users'
  budgets and do not multiply retries across workers.

The [MCP security guidance](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices)
informs these requirements. This is a separate implementation and validation gate;
do not simply expose today's local process on a network port.

Hosting the service on Infomaniak does not keep every tool result on that platform:
the configured AI client receives selected results and applies its own processing
and retention rules. Make that data flow clear during onboarding.

## Planned write lifecycle

```text
inspect -> plan -> independent approval -> execute -> observe -> verify
                        |                    |                     |
                  expire / invalidate   unknown outcome      verified outcome
                                             |
                                         reconcile
```

Approval binds the operation/schema version, exact arguments and affected
account/resources, relevant preconditions, plan hash, expiry and single-use
execution authorization. Approval is recorded by the trusted client or approval
service; it cannot be created by the model. A model-visible plan ID is not approval.
Changed preconditions require a new plan and decision.

Persist execution intent before a side effect. Reconcile timeouts, crashes and
partial results before any retry; use provider idempotency and conditional updates
where available. Do not promise exactly-once behavior without provider support,
or atomicity when preconditions cannot be checked atomically. Verification is
specific to the operation, not just an HTTP success code.

Restoration is explicit: some changes have a tested compensating action, others
need recovery from backup, and some are irreversible. A compensating write is a
new controlled operation; it must not overwrite intervening user changes. A
deployment restore requires a previously verified release and real release support.
