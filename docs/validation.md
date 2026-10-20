# Validation — 20 October 2026

Version 0.2 is an unpublished development build. It has full public catalogue
discovery, 17 reviewed operations and controlled execution. All eight write
handlers have fixture coverage; none has disposable live mutation qualification.
Initialized policies disable writes and writable resource grants.

## Local and protocol checks

- 61 Node tests pass on macOS with Node 24.18.1 and on Debian Linux with Node
  22.23.3, after strict TypeScript compilation.
- Three Python catalogue-import tests pass, including staff filtering,
  deterministic output and invalid/conflicting metadata rejection.
- Formatting and Claude Code 2.1.304 manifest validation pass. The validator advises
  adding a marketplace install command when one exists; no marketplace release
  has occurred.
- `npm audit --omit=dev` reports zero known runtime dependency vulnerabilities.
  Dependencies are pinned. This does not audit the operating-system images or
  the optional upstream adapter's dependency tree.
- A macOS/Linux, Node 22/24 CI matrix and an isolated container job are prepared.
  No remote CI run has occurred. Test-file concurrency is capped at two to avoid
  process-startup timeouts under heavy parallel load.

The tests exercise the compiled entrypoints through real MCP SDK stdio/HTTP
clients, using fake credentials and provider fixtures. They cover all eight
write handlers, exact previews, strict account/resource grants, narrow DNS-name
and mailbox scope, independent approval, expiry, stale state, replay, uncertainty,
readback failures, durable locks, crash recovery and private state permissions.
Plan fingerprints are independent of object insertion order and locale.
The real healthcheck entrypoint reaches IPv4 and IPv6 listeners with the
configured public Host header.

Two remote principals are exercised: one cannot read, approve or execute the
other's plans. Tests also cover credential-role separation, approval login/logout,
Origin/Host validation, CSRF, HTML escaping, body limits and default write rejection.
HTTP tests submit actual approval forms; they are not visual browser tests.

The existing three-tool read-only edition remains covered, including entry-file
integrity, narrow child environment and a fake backend attempting a prohibited
POST. Catalogue entries cannot admit themselves to execution. Provider requests
reject foreign origins/redirects, suppress error bodies, enforce response limits
and never automatically retry mutations. Incomplete pagination fails explicitly.

## Packaging and container checks

The local npm bundle installs in a clean Node container with no host credentials,
backend or author policy. The installed entrypoint starts token-only discovery,
advertises four tools and reports 1,514 catalogue entries with writes disabled.
That test performs no Infomaniak calls. Dependency installation uses the npm
registry; dependencies are not embedded in the tarball.

The runtime image builds from a digest-pinned Node base. Its isolated smoke test
passes with eight HTTP tools, disabled writes, a non-root user, read-only root
filesystem and networking disabled. A forced process kill/restart and the real
healthcheck command pass. Compose configuration and Caddy configuration validation
also pass; neither proves public TLS or deployment on a VPS.

## Live read-only evidence

At 11:39 UTC, 12 live checks passed through the controlled runtime and token-only
discovery edition. They cover all nine reviewed reads, including firewall reads
for both accessible VPS, plus public account/product discovery. The selected mail
hosting returns six mailboxes and its DNS zone returns 21 records.

Writes stayed disabled. The harness also enforced GET-only provider transport;
no domain, mailbox or server settings were changed. The existing provider token
was supplied only through the test process environment, not saved by the plugin.
Live account identifiers and output remain outside this repository and bundle.

VPS reads used a detached, clean development build of the existing MCP at
`341ea66`, with its entry-file checksum configured explicitly. That token-only
VPS capability is not an assumed published upstream release. The checksum covers
the entry file, not the entire dependency graph.

Private evidence outside this repository includes:

- `../live-validation/controlled-api-smoke-results.json`
- `../infomaniak-ai-tests.log` and `../infomaniak-ai-node22-tests.log`
- `../infomaniak-ai-bundle-smoke.json`
- `../infomaniak-ai-container-smoke.json`
- `../infomaniak-ai-docker-build.log`
- `../infomaniak-ai-audit.json` and `../infomaniak-ai-format.log`

## Remaining release gates

Most of the 1,514 catalogue entries have no executable adapter. Their visibility
does not establish schemas, permissions or live compatibility. Public Cloud and
other separately documented service APIs need their own reviewed integrations.

No live mutation, application deployment, preview, promotion/rollback, arbitrary
SSH action or VPS lifecycle write has been verified or enabled by default. A
provider state matching the plan does not prove DNS propagation, mail delivery
or application health. External edits can race without provider conditional-write
support; unknown outcomes remain locked instead of being retried.

No public Infomaniak-hosted instance, production TLS, operational restore exercise,
OAuth/SSO onboarding or public signup flow has been tested. Remote clients require
manually provisioned Bearer credentials and separate provider/human credentials.
Native Claude and other AI-client onboarding have not been exercised end to end;
manifest validation and SDK tests do not establish that result. No global user
client settings have been changed, and nothing has been published or deployed.
