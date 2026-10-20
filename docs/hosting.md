# Hosting on Infomaniak

Local use requires no server. This guide describes the optional self-hosted
Streamable HTTP edition on an Infomaniak VPS. It does not deploy anything or
establish production qualification.

## Current authentication

Each configured principal has a distinct MCP connection token, a distinct human
approval key and a distinct provider API token. Only hashes of the first two are
stored in the private policy. Provider credentials come from the named environment
variable or private `_FILE` source. There is no shared operator token for customers.

This version supports clients that can configure a Bearer header. It does not
implement an OAuth authorization server, public user registration or Infomaniak
SSO. A client requiring an OAuth connection flow cannot use that onboarding yet.

The same process can serve several explicitly provisioned principals, with
separate grants and operation namespaces. Automated registration, credential
enrollment and horizontally scaled workers are not implemented. The current
operator provisions accounts manually and is part of the trusted boundary.

## Prepare an isolated host

Use a host whose capacity, ports, backups and intended changes have been reviewed.
An existing production VPS is not automatically the deployment target. Docker
and Compose must already be installed and supported there. The runtime and proxy
images are pinned by digest; refresh them deliberately and rerun checks.

After building locally, initialize a new private directory with actual identifiers:

```sh
node dist/admin.js init \
  --directory /absolute/private/infomaniak-ai \
  --account ACCOUNT_ID \
  --zone example.com \
  --dns-source _infomaniak-ai-test \
  --container \
  --public-origin https://ACTUAL_HOSTNAME
```

Add only the product grants required. Generated resources are not writable or
marked disposable. Confirm account/resource ownership when creating these grants;
the policy is an administrator's authorization decision, not an ownership scan.

The container configuration uses `/var/lib/infomaniak-ai` for state and listens
on its internal port 8787. The public origin must exactly match the external HTTPS
origin. The application validates Host and Origin headers and does not trust
forwarded headers to choose its identity.

Create the private provider-token file through an appropriate secret interface.
Do not paste its contents into chat, source control or a command-line argument.
Files must be regular, readable by the container UID, and mode 0600. The state
directory must be owned by that UID and mode 0700. The entire private directory
belongs outside the checkout.

## Compose and HTTPS

Set non-secret deployment variables for `deploy/compose.yaml`:

```text
INFOMANIAK_AI_PRIVATE_DIR=/absolute/private/infomaniak-ai
INFOMANIAK_AI_HOSTNAME=actual-hostname.example
INFOMANIAK_AI_UID=1000
INFOMANIAK_AI_GID=1000
```

Use the actual owning UID/GID; defaults are 1000. Place the private policy at
`access.local.json`, the provider secret at `provider-token` and state in
`state/` within that directory. If there are multiple principals, add a distinct
secret source and read-only mount for each credential environment name.

The gateway image has a non-root default user. Compose additionally uses a
read-only root filesystem, dropped capabilities, no-new-privileges, a temporary
scratch directory and a persistent private state mount. Port 8787 is exposed only
to the proxy's Docker network. Caddy owns public ports 80/443 and certificate
storage. Provision the actual DNS hostname before requesting public TLS.

Commands to run only on the chosen host after reviewing that configuration:

```sh
docker compose -f deploy/compose.yaml config --quiet
docker compose -f deploy/compose.yaml up --build -d
```

The repository has not run these deployment commands on an Infomaniak VPS. TLS,
external client access and real-host firewall behavior need live verification.

Connect a compatible client to `https://ACTUAL_HOSTNAME/mcp`, supplying its
application connection token through the client's secure configuration.
The human uses `https://ACTUAL_HOSTNAME/approvals` and the separate approval key.
Neither provider nor approval credentials are accepted as MCP access tokens.

## State, recovery and limits

One gateway process owns each state directory. SQLite WAL transactions persist
plans, approvals, operation state, events and resource locks. Do not share the same
directory between containers, hosts or replicas. The runtime lock detects a live
owner and recognizes a new process instance even when a container reuses PID 1.

After a crash, executing operations become unknown. Pending/unknown operations
retain their resource locks; refresh them through readback before another change.
There is no automatic replay or universal undo. If readback never establishes the
desired state, keep writes stopped and investigate the provider outcome. Never
delete operation rows or locks to make a retry appear safe.

Before an upgrade, reconcile pending work and cancel unused plans. Preserve the
previous pinned image: changed operation definitions invalidate old approvals,
and uncertain old operations may need their original adapter version to reconcile.
This release has no automated journal migration across incompatible operations.

For a simple backup, stop the service cleanly and back up the complete private
state directory with its permissions, alongside the private policy and separately
protected credentials. Do not copy only the main SQLite file from a running WAL
database. Test an offline restore before relying on that backup. No remote backup
service is configured by this project.

Approval sessions are in memory and expire after 30 minutes; restart clears them.
Changing/revoking configured credentials requires a controlled restart. Local
operators or other tools with full access to the process environment, private
files or code can bypass this gateway; it cannot constrain the entire AI host.

The process conservatively serializes central API traffic across users. Native
requests have deadlines and response limits; writes never automatically retry.
Provider limits still apply, and the plugin does not control other applications
using the same account.

## Isolated container check

```sh
docker build --tag infomaniak-ai:local-0.2.0 .
python3 scripts/container-smoke.py
```

This creates one named disposable container with fake credentials, networking
disabled and a private temporary state directory. It checks the real HTTP MCP
server, default write rejection, non-root/read-only isolation, healthcheck and
crash restart, then removes only that test container and its temporary fixtures.
It does not exercise public TLS or an Infomaniak account.
