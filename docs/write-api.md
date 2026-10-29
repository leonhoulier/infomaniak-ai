# Resource API in version 0.3

The shared service now supports consented DNS records, aliases and forwarding,
and paired deployment runners. Read [resource workflows](resource-workflows.md)
for current operations, approval, recovery and limitations. The JSON routes below
retain the same lifecycle. Existing grants keep their original scope.

The following section records the earlier disposable-TXT beta and its evidence;
it is retained for legacy clients and operator rollback reference.

# JSON read and write API

The shared hosted service accepts OAuth-protected JSON requests at `/api/v1`.
New client registrations offer read and write access by default. Customers can
choose read-only access. The current write beta supports: create, update and delete TXT records at `_infomaniak-ai-test` in one
explicitly consented Infomaniak domain. Each exact plan needs a separate approval
in the consenting browser. Mail, VPS and other DNS mutations are unavailable.

The separate policy edition exposes the same JSON routes over its existing
reviewed handlers and manually provisioned per-principal grants. Its broader
write handlers have separate qualification requirements.

## Hosted authentication

Use OAuth authorization code, S256 PKCE and dynamic client registration against
the service's metadata. Read access uses `infomaniak:read`. A write connection must
also include `infomaniak:write:disposable-dns`. New registrations and authorisation
requests without an explicit scope offer both scopes; explicit read-only scopes
remain authoritative. In browser consent, the customer
chooses an account, keeps DNS writes selected and enters a domain verified
by the provider's domain-product inventory for that account. A token or scope
request alone cannot grant write access. Existing connections do not gain writes.

The JSON API and MCP share the `/mcp` OAuth resource identity. Send the resulting
OAuth credential in an Authorization Bearer header. Never send the Infomaniak
provider token as the API credential. Client credentials cannot approve a plan;
browser cookies cannot authenticate the JSON API. Dropping the write scope on
refresh removes write access from the connection.

## Routes

| Method | Path                           | Purpose                                                      |
| ------ | ------------------------------ | ------------------------------------------------------------ |
| GET    | `/api/v1/capabilities`         | Effective reads and consented write scope                    |
| POST   | `/api/v1/reads`                | `accounts.list` or `products.list` in the approved account   |
| POST   | `/api/v1/plans`                | Create an exact preview without a provider mutation          |
| GET    | `/api/v1/plans/{id}`           | Inspect your own plan                                        |
| POST   | `/api/v1/plans/{id}/execute`   | Execute an independently approved matching plan once         |
| POST   | `/api/v1/plans/{id}/reconcile` | Read back an uncertain result without repeating the mutation |
| POST   | `/api/v1/plans/{id}/cancel`    | Cancel before execution starts                               |

POST bodies must be JSON, uncompressed and at most 16 KiB. Credentials and query
parameters do not belong in URLs. Host and browser Origin are checked, responses
are no-store, and API requests share the MCP concurrency limit. There is no
generic HTTP executor, shell endpoint or JSON approval endpoint.

Example plan body, using documentation-only values:

```json
{
  "operation": "dns.record.create",
  "arguments": {
    "account_id": 123,
    "zone": "example.com",
    "source": "_infomaniak-ai-test",
    "type": "TXT",
    "target": "disposable API test",
    "ttl": 300
  }
}
```

For update/delete, supply the exact `record_id` and
`expected_source: "_infomaniak-ai-test"`. Non-TXT records at that name are protected.
The reviewed schemas returned by MCP search include the account, zone, source
and type constraints; a submitted argument cannot widen them.

The 201 response contains `plan`, `approval_required` and a relative
`approval_url`. On the shared service that URL is `/write-reviews/{id}`. Open it
in the consenting browser for the JSON API, review the complete before/after values and impact,
then type APPROVE. After that decision, send `{"plan_hash":"HASH_FROM_PLAN"}` to
the execute route. Reconcile and cancel accept `{}`.

Always inspect `plan.state`. HTTP 200 means that a result was returned; it does
not mean a mutation succeeded. `verified` confirms provider readback, not DNS
propagation or application health. `unknown` and `pending` retain resource locks
and must be reconciled. No mutation is automatically retried. Plans expire after
ten minutes. Repeating execute cannot send another mutation from that journal.
API operation errors return a stable code without parser issues, provider error
bodies or request values. Policy denials return 403; missing tenant-owned plans
404; approval/state conflicts 409; expired plans 410; oversized bodies 413.

## Storage and recovery

Hosted plans, scope, resource locks and runtime lease are encrypted in the same
vault as credentials. Finished plans expire from live storage after seven days.
Uncertain operations and their locks remain for reconciliation or investigation.
A 30-second writer lease prevents two instances claiming the same vault. An
unclean restart may wait for that lease to expire; executing plans recover as
unknown, never as approved. A lost lease stops new provider requests.

Use the original vault and key on upgrades. Do not restore an older database as
a code rollback: it can revive old approvals and credentials. Restoring a backup
requires writes to stay disabled until provider state and the journal have been
reconciled. Provider APIs do not supply a universal transaction or undo.

For the separately provisioned policy edition, use its **client connection
credential** in the Bearer header and a separate human key at `/approvals`.
Its SQLite journal uses private permissions but is not application-encrypted;
use an encrypted volume and private backups. This storage model is distinct from
the encrypted shared hosted vault. No analytics was added to JSON API calls.

## Operator switch and evidence

The hosted process enables the DNS beta unless
`INFOMANIAK_HOSTED_DISPOSABLE_DNS_WRITES=false`. Compose reads
`INFOMANIAK_AI_DISPOSABLE_DNS_WRITES`, defaulting to true. The switch only
makes consent available; every customer still needs explicit account/domain
consent and per-plan browser approval. Token permissions are checked by the
provider at execution. Domains absent from the selected account's registered
domain-product inventory cannot enrol in this beta.

On 28 October 2026, a user-authorised live test created, updated and removed one
TXT record, then confirmed all 23 original record IDs and values were unchanged.
Infomaniak returned the TXT data in DNS presentation quotes; the verifier now
compares decoded TXT data, including quoted chunks and DNS escapes. The accepted
create was reconciled through reads, never resent. The test driver exercised both
roles under explicit user authorisation; it is not native client or human UI
qualification. The exact proof boundary is in [validation](validation.md).

The deployed HTTPS service was also checked with the standard MCP SDK: eight
tools for a write-consented connection, account-bound JSON reads, rejection of
an unapproved write, private browser review, cancellation, write-scope removal
and temporary-connection disconnection. That check issued no provider mutation.
Native ChatGPT, Claude and Grok UI onboarding remains a separate qualification.

## Browser form compatibility

Private pages send `Referrer-Policy: same-origin`, so native form posts retain
their same-origin `Origin` header while external referrers remain suppressed.
Public pages keep `no-referrer`. The server still refuses null/foreign Origins
and requires the browser cookie and CSRF field; it does not relax those checks.

## MCP native confirmation

On an MCP connection that negotiates form elicitation, a plan returns
`approval_method: "client"`. Call `infomaniak_execute` with that exact ID/hash;
the service asks the client to show the complete preview and collect acceptance,
decline or cancellation. Acceptance is bound to the original connection, account,
plan hash and expiry; current permissions and state are checked again before any
provider mutation. Nothing executes on decline, cancellation or a failed prompt.

Clients without form support, oversized previews and the JSON facade keep the
private `approval_url` path. The JSON API cannot submit a native approval. Never
pass `approved`, an acknowledgement, or a user token in the execute arguments.
An expired plan is recreated from current state, not extended or silently retried.
