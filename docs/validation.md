# Validation — 20 October 2026

This is an unpublished local foundation, tested on macOS with Node 24.18.1.
Deployment, promotion and rollback remain unimplemented.

## Local results

- 24 fixture, policy and MCP protocol tests pass after compiling with strict
  TypeScript. Tests require no real token or account.
- Formatting passes. Claude Code 2.1.304 validates the plugin manifest without
  warnings. It advises adding a marketplace install command when one exists;
  this project has not been published to a marketplace.
- `npm audit --omit=dev` reports zero known vulnerabilities in the plugin's runtime
  dependencies. The SDK is pinned at 1.32.1, upgraded from the initially reused
  1.29.0 after audit flagged an OAuth advisory. This plugin uses stdio, which the
  [advisory excludes](https://github.com/advisories/GHSA-6qxp-vccf-f47h), but uses the
  patched dependency anyway. The separate adapter's dependency tree is not covered
  by this plugin audit.
- A macOS/Linux, Node 20/24 CI matrix is prepared. No remote CI run has occurred.

Tests cover forbidden calls before connection, explicit account selection, hints
that cannot override policy, missing/legacy capabilities, transport method and
origin restrictions, redaction, input/output budgets, changed adapter files,
repeated catalogue cursors, duplicate tools, upstream errors and native metadata.
Protocol tests start the actual compiled plugin and a fake backend through the
standard MCP SDK. An intentionally misbehaving fake read handler attempts a POST;
the preloaded adapter guard blocks it.

## Live plugin smoke test

15 checks pass through the compiled plugin and a separately built adapter:

- Exactly three initial tools, status and progressive search.
- All nine advertised reads exercised: organization discovery, hostings, domain
  list/detail, DNS records, mail services/mailboxes, VPS inventory/firewalls.
- Live inventory: two VPS, twelve domains, three mail services; firewall reads
  pass for both VPS. The selected mail service returns six mailboxes and its DNS
  zone returns 21 records.
- Generic API execution and omitted account selection return MCP errors.

The existing token is passed only through process environments. Browser auth is
disabled. The gateway's read policy and adapter fetch guard remain active. No
provider settings were changed and no credentials were saved by the plugin.

The adapter was built from local `feat/vps-public-reads` at `341ea66` in a detached
validation worktree. This is a development build with token-only VPS support;
it is not a published upstream release. The runtime verifies its entry-file hash.

Private evidence, outside this repository:

- `../live-validation/plugin-smoke-results.json`
- `../infomaniak-ai-tests.log`
- `../infomaniak-ai-plugin-validation.log`
- `../infomaniak-ai-audit.json`

## Proof boundaries

Manifest validation is not an installed-client end-to-end test. The MCP server is
verified over the SDK, but native Claude onboarding and other AI clients have not
been exercised with real user configuration. No user settings were changed.

Read coverage does not prove that a later deployment adapter can create previews
or restore an application. Those workflows need a supported authentication path,
a disposable app and host, explicit execution approval and independent readback.
