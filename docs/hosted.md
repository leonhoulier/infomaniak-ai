# Hosted Infomaniak AI

This is the primary public product: one shared service for Infomaniak customers.
Each customer connects their own token and explicitly chooses one account.
Customers need a supported AI app and an Infomaniak API token; they do not need
a VPS, SSH access, Node, a local server or an invitation from the operator.
The existing local plugin remains an alternative.

The service operator hosts and maintains the shared deployment on Infomaniak
once. Its VPS, SSH alias, hostname and encryption key are operator infrastructure,
not customer onboarding requirements. Every customer uses the same public `/mcp`
endpoint, with separate consent, credentials and account access.

The hosted pilot is live at [infomaniak-mcp.com](https://infomaniak-mcp.com),
with connection URL `https://infomaniak-mcp.com/mcp`. Public TLS,
account consent, real MCP reads, restart, revocation and backup recovery have been
verified. Version 0.3 adds resource-scoped DNS and mailbox administration,
paired customer-owned deployment runners, private operations history and runtime
downloads. New clients offer read/write access with a read-only choice. Existing
connections never gain resources during an upgrade. Each exact write still needs
independent confirmation: the client’s own dialog when form elicitation is
negotiated, otherwise the private browser review. See [resource workflows](resource-workflows.md),
[validation evidence](validation.md) and `/clients/status.json` for the qualification
boundary. Native Codex OAuth and a tool call have been verified; other native
clients and independent security review remain under qualification.

For a private browser walkthrough with demo data or your own read-only account,
see [testing the hosted experience](testing.md). The one-command preview does not
deploy a service or connect a native AI app.

## Customer experience

1. Add the operator's HTTPS `/mcp` URL as a custom MCP connection in the AI app.
2. Choose OAuth. The app opens the service's private connection page.
3. Enter an Infomaniak API token in that page's password field. It never goes
   into chat, a URL, a command argument or the AI app's connection settings.
4. Choose the account, name the domains and existing mailboxes to manage, and allow selected access. Leave resource changes off for read-only discovery.
5. Return to the AI app and ask, “Show my Infomaniak services.”
6. For a change, inspect the exact preview, then confirm in the client’s own dialog.
   Browser review remains the fallback for clients without form elicitation or
   previews too large to show completely. Provider credentials still use only
   the private browser consent page.

Onboarding is self-service. A previously unknown customer can connect as soon as
their token's account access is verified through Infomaniak. The operator does
not add customer account IDs, create principals or supply a shared provider token.
An AI workspace may still require its own administrator to enable custom apps.

The consent page displays the requesting client and its callback host. The client
name is not verified branding; users should check the return destination. OAuth
is between the AI app and this service. It is not Infomaniak OAuth or an
Infomaniak Manager sign-in: the current flow uses the customer's API token.

`/connections` lets the same browser disconnect its connections and delete their
live stored provider token. Other browsers do not see those connections.
Management cookies last 30 days. For lost/shared browsers, revoke the provider
token in Infomaniak or ask the operator to remove the connection. Do not share
one Infomaniak token across connections if you need independent provider-side
revocation.

## Authentication and storage

The standard MCP SDK supplies OAuth metadata, dynamic client registration,
authorization-code/S256 PKCE handlers, token exchange and Bearer verification.
The provider binds the client, exact callback, canonical `/mcp` resource audience,
`infomaniak:read` scope, chosen account and user consent.

- Authorization requests expire after ten minutes; verified token entry gets at
  most another five minutes within that original deadline.
- Authorization codes are single-use and expire after 60 seconds. Abandoned codes
  are pruned with their unactivated connection and token.
- Access tokens last at most 15 minutes. Refresh tokens rotate; replay revokes
  their entire connection. Connections expire after 30 days without extension.
- Revocation stops new requests immediately. An already running provider read
  may finish. Revoking another client's token cannot disconnect its connection.
- OAuth access, refresh and code lookup keys are SHA-256 hashes of random 256-bit
  credentials. Those credentials are separate from Infomaniak API tokens.
- SQLite values, including provider tokens, client secrets and pending consent,
  use AES-256-GCM with fresh nonces and record-specific authenticated data. The
  encryption key is a separate private file and is never included in responses.
- The database, WAL and key are private files on Unix. State survives a restart;
  the wrong key fails startup. Encryption protects a stolen database without its
  key. The operator/server can decrypt credentials to make API requests.

A hosted connection cannot select accounts outside its consent or call arbitrary
API routes. Reads use GET; reviewed DNS and mailbox changes use POST, PUT or DELETE
after exact browser approval. Fixed deployment actions use a separately paired
customer-owned runner. There are no generic SSH, shell or email-message-reading tools. Account/product information
returned by MCP is available to the AI platform under that platform's terms.

Public DCR supports `none` and `client_secret_post`. Unclaimed client registrations
expire after one day; a live connection retains its registration for the connection's lifetime.
Client metadata remains until operator cleanup. CIMD, private-key JWT, SSO,
mTLS client verification and Infomaniak delegated OAuth are not implemented.
Do not advertise CIMD support. ChatGPT can use DCR when its builder selects that
flow; native compatibility must still be established.

## Operator preparation

The current deployment uses an explicitly selected existing VPS and its Nginx
proxy. See [the deployment record and runbook](deployment.md).

This section is for the person running the shared service, not each customer.
Use a separate Infomaniak VPS and hostname designated for this service. Do not
install the service on an existing production VPS without selecting it explicitly.
Requires Node 22.13+ to build and initialize, Docker Compose and inbound 80/443
for the HTTPS proxy. Nothing in the following preparation creates a provider
resource, changes DNS or installs software on a remote host.

From the checkout:

```sh
npm ci --ignore-scripts
npm run build
node dist/hosted-admin.js init --directory /absolute/private/infomaniak-ai-hosted
```

The directory must be new and outside Git. Initialization creates a `0600`
`hosted-key` and a `0700` `state` directory, without a provider token. Keep the
key outside normal application/database backups, with a separately protected
recoverable copy. Losing the key loses the stored connections.

For container deployment, the key/state must be owned by the gateway's UID/GID.
Use a non-root host account owning the private directory through `INFOMANIAK_AI_UID`
and `INFOMANIAK_AI_GID`. The image drops capabilities, has a read-only root and
uses an unprivileged user; its runtime key is a read-only mount.

Prepare these non-secret environment values locally:

```sh
export INFOMANIAK_AI_HOSTED_PRIVATE_DIR=/absolute/private/infomaniak-ai-hosted
export INFOMANIAK_AI_HOSTNAME=your-actual-hostname
export INFOMANIAK_AI_UID="$(id -u)"
export INFOMANIAK_AI_GID="$(id -g)"
docker compose -f deploy/hosted.compose.yaml config --quiet
```

After selecting the actual host, configuring DNS and approving publication:

```sh
docker compose -f deploy/hosted.compose.yaml up -d --build
```

Caddy terminates HTTPS and preserves the original Host. Do not expose the gateway
port directly, log request bodies/query credentials, or enable broad proxy-header
trust. The app does not trust arbitrary forwarded headers. Standard OAuth rate
limits may be shared across users behind the proxy; capacity/proxy policy needs
qualification before a wider launch. The pilot caps registrations at 2,000 and
pending authorizations at 1,000, with bounded bodies, token attempts and MCP
concurrency. This is not a multi-region or horizontally scaled service.

When the host already runs Nginx on ports 80/443, use
`deploy/hosted.nginx.compose.yaml` instead. It extends the gateway configuration,
publishes it only on loopback port 3210, and limits memory, CPU, processes and
container logs. Render the hostname/port placeholders in `nginx.hosted.conf` for
a separate virtual host. `nginx.hosted.bootstrap.conf` serves only ACME while
the certificate is being issued. Validate Nginx before reloading; never replace
an existing site's configuration. The example access log excludes client IPs,
query strings, credential headers and request bodies.

The operator URL is `/`; the AI connection URL is `/mcp`. The health endpoint is
`/healthz`. Startup requires `INFOMANIAK_HOSTED_ORIGIN`,
`INFOMANIAK_HOSTED_KEY_FILE` and `INFOMANIAK_HOSTED_STATE_DIR`; `--hosted` never
falls back to the operator's local provider token or policy. Plain HTTP requires
an explicit loopback-only development flag and cannot enable an internet HTTP
origin. Bare Node startup binds loopback by default; the Compose gateway explicitly
binds its private container network, with only Caddy exposing public ports.

## Operate and recover

Run these on the host with private access to the original directory:

```sh
node dist/hosted-admin.js list --directory /absolute/private/infomaniak-ai-hosted
node dist/hosted-admin.js revoke --directory /absolute/private/infomaniak-ai-hosted --connection OBSERVED_ID
```

Only connection IDs, account IDs, client IDs and expiry dates are printed; no
provider or OAuth credentials. Application retention pruning runs every minute.
Completed plan history is kept for up to seven days, bounded to 200 plans per
connection and 20,000 across the service. Only unfinished plans count toward the
active limits: 20 per connection, 100 per Infomaniak account and 2,000 overall.
Disconnecting does not unlock an uncertain write: the provider may have applied
it, and an in-flight request may still finish.
Unresolved deployment jobs retain their signed-result evidence alongside the
plan and lock. After the plan resolves, that job history expires after seven days.
Disconnecting or expiry blocks new jobs but does not block signed results for
already-issued work. Revoking a runner also blocks new work; it can only report
completion of deployments it already received. Its verification identity is kept
while such work remains unresolved, then expires after seven days. New logs and
unrelated reports from a revoked runner are refused. Stop its service on the VPS
if you need to stop the local process itself.

For an orphaned pending/unknown operation, stop the affected runner if this is a
deployment, then inspect the provider. A delivered job cannot be recalled by the
gateway. Stop the gateway, wait for its 30-second writer lease to expire, and
list the operation IDs:

```sh
node dist/hosted-admin.js plans --directory /absolute/private/infomaniak-ai-hosted
node dist/hosted-admin.js abandon --directory /absolute/private/infomaniak-ai-hosted --plan OBSERVED_ID --reason "Manual provider inspection and investigation details" --acknowledge-uncertain-write
```

Abandonment records an explicitly unverified outcome and releases only that
plan's lock. Queued deployment jobs are disabled in the same transaction. A job
already delivered to a runner must have a confirmed terminal result; otherwise
abandonment is refused and its lock stays in place. Recover the runner and obtain
its signed completion first. It neither retries the mutation nor establishes success or failure.
Restart the gateway, inspect current state and use a new reviewed plan if needed.

Upgrades retain narrowly scoped readback support for already-sent 0.3.1 plans.
Unsent older plans must be cancelled and recreated; they cannot execute under a
changed operation schema. Unknown operation revisions remain refused.
Encrypted backups can retain revoked token ciphertext; declare an actual backup
retention policy and revoke the Infomaniak token if a retained copy must stop
working. Changing the encryption key in place is not supported. The vault is also bound
to its original public origin: changing domains requires a new isolated
installation and user reconnection, so old credentials cannot be reused for
another MCP resource.

For a consistent backup, stop the gateway, copy the state directory and start
it again. Protect the key separately. Rehearse restoring both into an isolated,
network-disabled environment and verify that connection/revocation state is
preserved. Restoring an old backup may restore previously revoked credentials;
revoke those provider tokens and reconnect users before opening a restored
service to traffic. Test crash/restart, TLS renewal, monitoring, deletion and
restore operationally before public launch.

## Platform guidance

- ChatGPT: open Plugins, then the plus button and Add custom MCP server. Configure
  the endpoint with OAuth and DCR, create/install the plugin and select it with @.
  Availability
  and publication depend on its current workspace/plan and review process.
- Claude web: add the HTTPS endpoint through its remote MCP/custom connector
  settings, choose automatic client registration and complete the browser consent
  flow. This build does not support Claude’s published-identity/CIMD mode.
- Grok web: add a custom MCP connector with the service URL and complete auth.
- Remote-capable coding clients can use the same endpoint and OAuth rather than
  storing a local Infomaniak token.

Protocol tests are not platform certification, native UI validation or a
marketplace listing. Official references:
[OpenAI authentication](https://developers.openai.com/plugins/build/auth),
[Claude remote MCP](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp),
[Grok connectors](https://docs.x.ai/grok/connectors),
[MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

## New-connection defaults, 28 October

New client registrations and unscoped authorisation requests offer the supported
read/write flow. DNS writes are checked in the consent form; the customer must
still choose an account, enter a verified domain and allow access. Uncheck DNS
writes to connect read-only without a domain. Explicit client read-only scopes and
existing read-only grants are preserved. Each mutation still needs a separate
browser review. The current scope covers the disposable TXT name only. Operators
can disable the feature with `INFOMANIAK_HOSTED_DISPOSABLE_DNS_WRITES=false`
(or `INFOMANIAK_AI_DISPOSABLE_DNS_WRITES=false` in Compose).

## Native write confirmation

Version 0.3.3 adds MCP form elicitation for hosted writes. A client that negotiates
form support receives a bounded, connection-bound Streamable HTTP session. On
`infomaniak_execute`, the server displays the complete account, operation, target,
before/after values, impact, recovery and expiry through that client. Acceptance
approves only the supplied plan hash, then execution performs the existing fresh
state check. Decline/cancel sends no provider mutation. A conversational yes or
model-supplied approval field cannot replace the client response.

The service trusts the selected MCP client to route elicitation to the user. A
client configured to auto-answer forms can automate that response; this protocol
is not proof of a human identity. Do not configure automatic acceptance for write
confirmations. Credentials are never requested through an MCP form.

Sessions are in memory, bounded per connection/account and globally, and expire
after ten idle minutes. Permission changes or revocation cancel pending prompts.
Only one confirmation per connection and two per account can be open at once.
Existing JSON API clients still approve through the browser; there is no generic
approval endpoint or model-accessible approval tool. Old clients without form
support retain their stateless path. Native UI qualification is recorded separately
from protocol fixtures and capability negotiation.
