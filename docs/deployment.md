# Deploying the hosted service

The shared service is at [infomaniak-mcp.com](https://infomaniak-mcp.com).
Customers connect their own accounts through OAuth; they do not need to host it.
Self-hosting is also possible. Start with [hosted.md](hosted.md) for the supported
configuration, private key, encrypted store and operator commands.

## Build one release

Build the container from a known source commit and give it an immutable release
tag. Package the runner and plugin archives from that same source. Publish their
checksums alongside the release; do not reuse a version for different public
bytes. The container builds its downloadable runner from its own compiled source.

Use `deploy/hosted.compose.yaml` directly or the Nginx overlay at
`deploy/hosted.nginx.compose.yaml`. Keep the gateway on a private interface behind
TLS. Restrict the origin and OAuth issuer to the hostname customers actually use.

## Proxy and credentials

At a single trusted reverse-proxy hop, overwrite `X-Forwarded-For` with the client
address and set `INFOMANIAK_HOSTED_TRUST_PROXY_HOPS=1`. Do not trust a forwarded
header supplied by the public client. The Nginx overlay binds the gateway port
to loopback. Adjust the configuration to the actual proxy topology.

Keep the encryption key and state outside the source checkout. Use restrictive
file permissions, persistent mounts and encrypted backups. Never replace an
existing key or start a second writer against the same vault during an upgrade.
Provider tokens belong only in the private consent flow, not the container image,
repository, command arguments or release assets.

## Upgrade

1. Run the fixture suite, image smoke checks and package integrity checks.
2. Test startup and migrations on a private store copy with networking disabled.
3. Pause new POST requests and drain accepted work before stopping the gateway.
4. Inspect unresolved writes. Keep pending or unknown requests locked and
   reconcile them; do not replay them. Preserve unresolved runner evidence.
5. Take and verify a backup, then start the new image with the existing key,
   mounts and operator configuration.
6. Check health, issuer metadata, anonymous refusal, capabilities, version and
   exact download checksums before reopening POST requests.

Do not restore an old database after reopening writes: that could lose accepted
operations and their locks. Code rollback and state recovery are different
procedures. Use the documented operator recovery path only after inspecting
the provider and runner evidence; an in-flight deployment cannot simply be
abandoned to release its lock.

For the Zod 3-to-4 upgrade, recreate unsent plans. Only narrowly allowlisted
legacy sent plans retain readback reconciliation under the new runtime.

## Verification

Check public HTTPS routes separately from authenticated client workflows.
`/healthz` is an availability signal, not proof of provider access, successful
deployment or every client's OAuth behavior. Complete fresh client qualification
and a designated disposable write before claiming a supported workflow.

Keep deployment logs, backup locations, keys, reviewer credentials and account
details in private operator storage. See [monitoring.md](monitoring.md),
[validation.md](validation.md) and the [privacy policy](https://infomaniak-mcp.com/privacy).
