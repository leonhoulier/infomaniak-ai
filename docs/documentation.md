# Official documentation access

Every MCP edition includes two read-only documentation tools. Hosted connections
use their existing OAuth read scope; no additional provider scope is needed.

`infomaniak_docs_search` searches live official help articles by default:

```json
{ "query": "create email address", "source": "help", "language": "en", "limit": 5 }
```

Help search supports `en`, `fr`, `de`, `it`, `es`, `nl` and `pt`. Infomaniak
receives the public topic query. Never include customer addresses, account IDs,
credentials or private context. With `source: "api"`, the tool downloads the
current public developer index and matches terms locally; that index is English.
This is separate from the bundled operation catalogue and does not make newly
documented operations executable.

`infomaniak_docs_read` retrieves a result URL:

```json
{ "url": "https://www.infomaniak.com/en/support/faq/1973", "max_chars": 8000 }
```

It returns readable steps, links and official image references for help articles,
or the developer portal's structured operation reference. The portal regenerates
example values on each request; `example`, `examples`, `x-codeSamples` and `x-payload` are
explicitly omitted so stable pagination checks the actual schema. Descriptions,
parameters, schemas, responses and scopes remain live. Follow `next_offset`
when `truncated` is true, passing `content_sha256` as `expected_sha256`. Every
page request fetches again; a changed document returns `documentation_changed`
instead of silently combining versions. Results include `retrieved_at`, the final
official URL and publisher modification metadata where provided. Retrieval time
does not prove when the publisher last updated the instructions.

Only fixed official HTTPS documentation hosts/paths are fetched. Requests carry
no Infomaniak API token, cookies or caller-supplied headers. Redirects are checked
again before fetching. Downloads, parsing, output and time are bounded. Fetch or
format failures are explicit; there is no stale article fallback. The reader does
not execute JavaScript, load images, sign in or browse Manager.

For browser tasks, read the relevant guide, then use the agent platform's own
authorized browser/computer tools. Check the visible account, exact product,
target resource and actual UI. Documentation can lag the interface. An unavailable
API feature may have a supported Manager workflow, but a denied scope, pending
approval, locked resource or uncertain mutation is not a reason to bypass a
control. Documentation is reference material and never authorizes a change.
Keep credentials and 2FA in the platform's private browser/secret flow.

OAuth-protected JSON equivalents use the same inputs:

- `POST /api/v1/docs/search`
- `POST /api/v1/docs/read`

Hosted anonymous requests remain refused. Local documentation tools do not
require an additional provider credential beyond the installation's normal setup.
