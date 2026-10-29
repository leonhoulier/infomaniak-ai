# Architecture

Version 0.2 has three entry modes. Token-only installation provides four read-only
discovery tools without author-specific configuration, a backend or persistent
state. An explicitly selected backend enables the original three-tool read-only
edition with its checksum and GET-only guard. A private policy enables the
controlled runtime's eight tools over local stdio and authenticated HTTP.

## Shared execution core

```text
Local AI client                     Remote AI client
      |                                   |
      | stdio                             | authenticated HTTPS MCP
      +------------------+----------------+
                         |
                  Operation gateway
          versioned catalogue / reviewed registry
          principal + account + resource authorization
             strict schemas / bounded output
                 /                   \
          reviewed reads         persisted change plans
                 |                   |
                 |          separate human approval channel
                 |                   |
                 |          execution claim + resource lock
                 |                   |
                 +---------+---------+
                           |
                 fixed provider requests
                           |
              readback / durable outcome journal
```

The public catalogue contains 1,514 pinned method/path entries. It is discovery
data, not an execution manifest. Sixteen selected public schemas retain their
source URLs. The reviewed registry currently has twelve read and eight write
handlers. Other entries cannot execute, regardless of model arguments.

The gateway keeps a small tool interface: status, search, catalogue, read, plan,
execute, operation status/reconciliation and cancellation. There is no approval
tool, arbitrary API path, method selector, shell executor or model-selected code.

## Provider boundaries and MCP reuse

Native reviewed operations use fixed public REST routes, validated parameters and
operation-specific bodies. Credentials come from the authenticated principal's
secret source, outside model arguments. Public API transport rejects foreign
origins and redirects, bounds response size and time, and never retries mutations.
Incomplete pagination fails explicitly before it can be treated as complete state.

Token-only VPS inventory and firewall reads reuse the existing
`infomaniak-mcp-agent` through the unchanged checksum/GET-guard boundary. These
calls join the controlled runtime's shared request queue. The backend is optional;
missing configuration appears as unavailable adapter support. Its companion
capability must be present before a VPS read is forwarded.

The checksum pins the adapter entry file, not its dependencies. The preload guards
the reviewed fetch client; it is not an OS sandbox for malicious executables.
Manager browser auth remains disabled. Backend exceptions and stderr are not
forwarded raw.

Central REST, separately documented service APIs such as OpenStack, undocumented
VPS routes and private Manager behavior remain distinct. Hosting a bridge does
not turn private browser operations into supported public APIs.

## Authorization and credentials

A private policy provisions explicit principals, distinct MCP access-token hashes,
distinct human approval-key hashes, provider secret sources, account IDs, reviewed
operation grants and resource bindings. Provider values are never persisted by
the gateway. Secret-file sources must be private regular files; conflicting
environment/file sources fail.

Accounts and child-resource grants are checked before reads/plans and again before
execution. DNS names use zone/source bindings; write operations can only inspect
and change records in that name. Broader zone writes require an explicit writable
zone binding. Mail-hosting inventory and individual mailbox grants are separate.
Every resource's writable flag defaults false, and initialized writes are disabled.

A write grant includes the reviewed preflight reads needed to preview that exact
resource. It does not enable arbitrary related reads. Manually provisioning a
resource/account binding is an operator authorization decision; this runtime does
not automatically establish ownership for every product.

Configured credentials and common secret fields are redacted from results.
Known secrets in write arguments or observed plan state are rejected before
persistence. Responses and plans have budgets; they fail rather than silently
truncating. This does not guarantee detection of every unknown secret.

Other host tools or a local operator with access to code, private files and process
credentials are outside this gateway's security boundary.

## Plans and independent approval

```text
inspect -> planned -> human approval -> approved -> executing -> pending -> verified
             |              |                        |            |
          cancel          expire                 stale/failed   unknown
                                                                 |
                                                        read-only reconciliation
```

Plans bind principal, account/resource arguments, operation/schema revision,
before/after state, exact request, effect/recovery notes, expiry and a SHA-256
fingerprint. The runtime rejects changed definitions, mismatched hashes, stale
state, expired plans and replayed execution. It rechecks expiry after preflight;
a queued mutation also has an approval-expiry deadline.

Human approval uses a separate key through a browser form or interactive
administrator CLI. MCP and provider credentials cannot log in to that interface.
Browser approval requires an authenticated same-site session, matching Origin,
CSRF value, exact plan hash and typed acknowledgement. There is no token returned
to the model that can mint approval.

The request graph for current writes is one native mutation, surrounded by reviewed
preflight/readback. The model cannot modify it after approval. Multi-request
provider workflows require a separate reviewed design; generic upstream two-phase
confirmation tokens are never used to authorize this executor.

## Durable state and uncertain outcomes

SQLite WAL transactions record plans, approval timestamps, states, events and
resource locks. The state directory/database are private and owned by the runtime
user. One gateway owns a directory; an administrator may open a second connection
for approval. Transactional execution claims prevent duplicate or conflicting
side effects. Runtime process identities handle container PID reuse on restart.

Execution intent and its lock commit before the provider mutation. An accepted
response leads to readback; only matching desired state becomes verified.
Timeouts, crashes or uncertain provider errors become unknown and retain the
lock. Pending/unknown reconciliation sends reads only. A failed observation is
not proof that the mutation did not happen.

There is no exactly-once guarantee without provider support, universal undo or
atomic compare-and-write when the endpoint lacks conditional updates. Concurrent
edits can still race between final preflight and mutation. A compensating action
would be a new independently approved operation that checks current state.

Changes to operation definitions invalidate old approvals. Operators should
reconcile outstanding work before upgrading and preserve the previous build for
uncertain operations whose definition has changed.

## Remote service

`src/remote.ts` uses stateless Streamable HTTP with manually provisioned,
application-specific Bearer tokens. Authentication selects the principal before
dispatch. SQL queries, approvals, backend credentials and policy checks retain that
principal. There is no shared operator provider token, cross-user state cache or
model-selected credential.

HTTP validates Host and Origin against the configured public origin, bounds request
size/concurrency and sets no-store, CSP and framing protections. Approval sessions
are in memory, cookie-protected and expire after 30 minutes. Login attempts are
limited. The service expects HTTPS through the pinned proxy outside loopback use.

This is not an OAuth server. Clients requiring OAuth onboarding, automated tenant
registration, encrypted hosted credential enrollment and horizontal workers remain
future work. Current provider secrets stay in private operator-managed files or
environment variables; a managed service needs an additional lifecycle design.

See [hosting.md](hosting.md) for container isolation, private state, backups,
restart and upgrade limits. The container test runs without external networking;
it does not prove public TLS or deployment on an actual Infomaniak VPS.

The gateway's hosting location does not determine where the AI client processes
returned results. That separate data flow must remain clear during onboarding.
