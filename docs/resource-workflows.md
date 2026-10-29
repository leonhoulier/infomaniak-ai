# Hosted resource workflows (0.3)

One HTTPS service, one approved Infomaniak account per connection. New clients
request read and write access. The browser consent names the domains and existing
mailboxes the client can manage. A customer can connect read-only instead.
Existing connections do not gain permissions during a server upgrade.

## Domains and mail

Use `resources.resolve` with an account and a product name to find product IDs.
`infomaniak_status` returns the exact consented mailbox hosting/name bindings.
Search loads the schemas for supported operations. A catalogue entry alone is
never execution permission.

DNS supports record reads, audit, propagation, expiry and record create/update/delete.
API source `.` means the zone apex. An MX target includes its priority. Updating
source/type requires a new record. TTL caches remain after provider readback.
Recovery prepares a new inverse plan; it never silently restores a previous value.

Mail supports metadata, aliases and forwarding for consented existing mailboxes.
Message content and passwords are excluded. Infomaniak enables aliases when the
first alias is added, and disables them when the last is removed. Adding a
forwarding recipient enables forwarding; removing the last disables it. Plans
include these effects. Infomaniak may send alias-change notifications to users.

## Approval and history

Prepare a plan and review the exact target and before/after values. When
`approval_method` is `client`, call execute with the matching `plan_hash` so the
client can request native confirmation before sending the change. Otherwise open
`approval_url` in the consenting browser, acknowledge the exact change, then execute.
Inspect `plan.state`; HTTP 200 alone does not prove success. Pending/unknown plans
keep their resource lock. Reconcile with reads instead of repeating a mutation.

`/operations` shows browser-owned connections, permissions and plan history.
Permission removal takes effect for subsequent requests. A request already in
progress can finish. Adding access requires a new consent or runner pairing.
Disconnecting deletes the live provider credential; encrypted history remains
for seven days. Uncertain plans keep their locks until investigated.

## Customer-owned VPS runner

Download the runtime from `/downloads` and check `/releases/latest.json` for its
hash. The shared service never receives SSH keys or app environment files. A
runner holds a local Ed25519 identity, pairs through the consenting browser and
accepts only signed jobs for its configured app/repository/hostname.

The first release supports stateless HTTP Dockerfile apps from HTTPS repositories.
There is no generic shell, private Git credential broker, database migration or
persistent-volume recovery. An explicit commit SHA pins every deployment. A
monorepo can set `--build-context vote --dockerfile Dockerfile`.

The Nginx adapter requires Docker, Nginx, certbot, an existing ACME account and
permission to install its own proxy file and reload Nginx. It refuses another
route's hostname. Regex hostnames require an external proxy. `--proxy external
--port PORT` leaves public TLS routing to the customer and reports loopback health
only. CPU/memory limits apply to app containers; builds run on the customer's host.

A candidate is health-checked before routing; public TLS health is checked after
Nginx reload. Failed initial deployments remove their owned route. A previous
release remains available for an independently approved rollback using its
retained immutable image. Application rollback does not restore external data.

Logs are requested explicitly and are scrubbed using values in the local app
environment file. This cannot guarantee removal of secrets produced by the app
from other sources. No log is collected automatically. Health reports contain
CPU/load, memory, uptime and configured app status.

After a forced crash, stop the old runner and inspect its journal before removing
only its stale `runner.lock`. Run `runner reconcile --directory DIR --job UUID`.
It reads owned containers and health endpoints without rebuilding, restarting or
switching a route. An ambiguous result stays unknown and locked.

## Compatibility evidence

`/clients` and `/clients/status.json` separate setup instructions, native OAuth
and native tool-call evidence. Native Codex 0.164.0 has completed OAuth and an
`infomaniak_status` call. Claude Code 2.1.310 has completed read/write OAuth and an authenticated native
handshake; a model-driven tool call remains unqualified. Other clients remain
unqualified until their own checks complete. A protocol fixture test is not platform certification.

Platform references checked on 28 October 2026: [Codex scopes](https://learn.chatgpt.com/docs/config-file/config-reference),
[ChatGPT plugin setup](https://developers.openai.com/plugins/quickstart), and
[xAI remote MCP](https://docs.x.ai/developers/tools/remote-mcp). The Grok guide
describes its documented API integration; it does not promise a native bot installer.
