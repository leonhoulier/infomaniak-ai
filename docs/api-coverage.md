# API coverage and write policy

This defines broad API support and the operation admission policy. Version 0.2
implements full catalogue discovery and 20 reviewed handlers: twelve reads and
eight independently approved writes. Writes are disabled by default. The original
three-tool read-only mode remains available. Nothing in this document alone
enables a route.

## Catalogue baseline

On 20 October 2026, the public
[developer portal navigation](https://developer.infomaniak.com/docs/api) contained
1,514 unique method/path pairs across 15 product groups, excluding entries or
ancestor groups marked `staff`. Counts include versions and deprecated entries;
they describe navigation metadata, not independently tested capabilities.

| Public catalogue group | Unique method/path pairs |
| ---------------------- | ------------------------ |
| AI Tools               | 19                       |
| Core Resources         | 71                       |
| Domain & Zone          | 34                       |
| Etickets               | 12                       |
| Mail Services          | 125                      |
| Newsletter             | 77                       |
| Public Cloud           | 75                       |
| Streaming radio        | 195                      |
| Streaming video        | 99                       |
| Swiss Backup           | 18                       |
| Url shortener          | 7                        |
| VOD                    | 420                      |
| kChat                  | 173                      |
| kDrive                 | 187                      |
| kMeet                  | 2                        |

This snapshot is not the denominator for every Infomaniak service. Separately
documented APIs, including OpenStack service endpoints, need their own inventories.
Some existing hosting/VPS adapter operations are absent from this navigation and
must be labelled by their actual documentation/authentication status. No inference
of universal product support from the central REST catalogue.

The immediate priority remains domains/DNS, mail and VPS. The registry should
cover the whole catalogue while execution expands through reviewed operations.
The goal is complete supported coverage with explicit gaps, not a tool count.

## Coverage registry

Generate searchable metadata and schemas where official machine-readable sources
exist; otherwise record provenance and reviewed extraction. Do not assume the
navigation contains complete request/response definitions or scope requirements.
Never guess missing schemas and enable a route based on its name or HTTP method.

Each versioned operation entry should record:

- Stable ID, product, API/version, method, fixed route template, documentation URL,
  source revision/hash and last checked date.
- Publicly documented, separately documented, undocumented or private status;
  deprecation and replacement information.
- Request/response schemas and limits, pagination and any asynchronous lifecycle.
- Credential type, scopes, principal/account/project/resource constraints and any
  secret-returning fields. Missing scope evidence stays explicitly unknown.
- Risk class, side effects, cost/external-recipient impact, approval requirements,
  idempotency/conditional-update support and recovery limits.
- Implementation target: existing MCP operation or typed service adapter; reviewed
  request graph, output redaction and operation-specific verification.
- Separate evidence for schema review, fixture tests, disposable live tests and
  production enablement, each tied to operation and adapter versions.

Expose independent fields rather than one misleading supported flag:

```text
catalogued / schema_reviewed / implemented / fixture_tested / live_verified
policy_enabled / authentication_available / access_observed
```

Discovery can show an unsupported operation with the reason it cannot execute.
Having a local adapter is not proof of access; access observed for one resource
does not establish permission for every account. Never probe write permission by
issuing a mutation. Unknown access is checked again during authorized execution.

Catalogue updates produce a reviewable diff. New or changed routes, schemas,
request graphs and sensitive fields remain disabled until reviewed. Execution
uses pinned reviewed metadata, not a mutable documentation page fetched on demand.

## Risk and consent

Classify actual effects and information exposure per operation. A GET can expose
credentials or personal content; a POST can be a search or a billable inference.
The following policy guides admission. The current reviewed writes all require
explicit writable resource grants and fresh per-plan independent approval.
Secret, content, purchasing and other unreviewed operations remain disabled:

| Operation class                                              | Default treatment                                                                                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary inventory/status reads                              | Allow within explicitly selected account/resource permissions; redact and minimize results                                               |
| Private content, logs or exports                             | Require data-access consent with a clear scope; return only needed content                                                               |
| Credential/secret reads                                      | Keep values outside model-visible results; use references or a secure delivery channel; disabled until supported                         |
| Bounded reversible changes                                   | Preview exact before/after values and impact; require independent approval; execute once and read back                                   |
| Sending, sharing or publishing                               | Preview recipients/audience and content as well as changes; require explicit approval of that external action                            |
| Destructive, disruptive, billable or access-changing actions | Require fresh explicit approval, affected-resource acknowledgement, cost/recovery information and any necessary backup or recovery proof |
| Unclassified, undocumented or unverified mutations           | Discoverable as gaps; execution disabled by default                                                                                      |

Examples in the stronger-control class include deleting a mailbox or backup,
reinstalling a VPS, changing access rights, exposing a service publicly, ordering
products and changing mail routing. DNS changes can also interrupt service; risk
depends on the record and effect, not the product label.

No blanket "enable all writes" switch. Later automation policies can pre-authorize
a narrow low-risk operation/resource/argument range with expiry, execution count
and budget limits. The user grants that policy through a trusted interface; the
model cannot create or widen it. High-impact actions keep per-action approval.

Current policy supports disabled, disposable-only and deliberately enabled writes.
All modes still require explicit operation and resource grants; writable flags
default false. DNS source grants and exact mailbox grants prevent a test resource
from widening access to the rest of a live zone or mail hosting. Update/delete
under a named DNS grant must identify the expected source; the record ID must
exist within that name. Previews include only that name's records.

The first write set is DNS create/update/delete, mailbox alias add/delete, and
forwarding add/update/delete. DNS updates change only target and TTL. Forwarding
disable previews the documented removal of all recipients. These handlers have
fixture coverage; disposable live mutation qualification is a separate gate.

## Plan, approve, execute and verify

1. Resolve actual identifiers and check principal/resource authorization. Never
   silently choose the first account or accept a child ID without ownership checks.
2. Read current state and build a versioned plan: exact effects and before/after
   values, affected services, known costs, irreversible parts, dependencies and
   recovery options. Unknown costs or side effects remain visible and can block
   execution under policy. A preview is local computation unless a documented
   provider dry-run endpoint exists.
3. Present the plan through the trusted client or separate approval UI. Bind the
   decision to the principal, operation/adapter version, normalized arguments,
   account/resources, relevant state fingerprint, expiry and plan hash. A token
   supplied or returned to the model cannot record human approval.
4. At execution, recheck authorization, plan expiry and preconditions, then consume
   the authorization once. Serialize conflicting operations on the same resources.
   Use conditional requests where supported; report remaining race limitations.
5. Persist an operation ID and execution intent before sending a mutation. Bound
   the reviewed adapter's destinations, request graph, arguments, time, number of
   requests and any cost. Credentials remain outside model arguments and results.
6. Poll documented job/status endpoints where applicable and read back the actual
   resource. Report pending, verified, failed, partially completed or unknown;
   an accepted API request is not proof of completed work.
7. Reconcile uncertain outcomes before retrying. Apply supported idempotency keys;
   otherwise require operation-specific duplicate detection and safe reconciliation.
   Compensation is a separate controlled action that checks for intervening edits.

For multi-step changes, show the sequence, dependencies and failure points in the
plan. Do not promise an atomic transaction or universal undo. A batch must expose
partial progress and any action that requires a new approval.

The current journal stores plans screened for known secrets, approval/state events,
resource references, timestamps and outcomes. It does not retain provider request
or job IDs; asynchronous adapters need that support before admission. Protect the
journal as customer data, and never store credentials or full message/file content
merely to obtain an audit log.

## Authentication, rate limits and test gates

Infomaniak [API tokens](https://www.infomaniak.com/en/support/faq/2582/add-and-manage-infomaniak-api-tokens)
are configured by application and access scope. Use the least privilege available;
do not assume every product has separate read-only scopes. OAuth login support
does not prove a delegated application can obtain every management scope. Verify
the exact scopes and resource authorization for each supported product.

[Public Cloud identity](https://docs.infomaniak.cloud/identity/) recommends
application credentials and supports access rules. Its documentation notes
region-specific role behavior, including `reader` inheriting `member` permissions
in `dc3-a`. Never rely on the word "reader" as the runtime read-only boundary.

The [central API guide](https://www.infomaniak.com/en/support/faq/2581/discover-the-infomaniak-api)
currently states a 60-request-per-minute limit. Apply conservative scheduling for
that API, honor rate-limit responses and check service-specific limits separately.
Do not assume its counting boundary without verification or multiply requests
through parallel credentials to evade limits. Reads can use bounded retry;
uncertain mutations require reconciliation before any repeat request.

Before enabling an operation, validate malformed arguments, ownership failures,
missing access, sensitive output, rate limits, provider errors and partial results.
Writes additionally need tests for self-approval, stale or changed plans, replay,
duplicate execution, crashes/timeouts and the actual verification/recovery path.
Run live writes only against designated disposable resources with bounded cost.
An unavailable product remains live-unverified; never label fixture results as
proof that it works with a real account.
