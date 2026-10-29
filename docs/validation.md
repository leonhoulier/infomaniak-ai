# Validation

## Release 0.3.4

The release adds client-native confirmation through MCP form elicitation, with
browser review for clients without form support and for the JSON API. Neither
a model argument nor installation consent approves an individual write.

The local regression suite contains 197 tests, including 27 native-confirmation
tests using the standard MCP SDK over real HTTP and synthetic provider data.
Coverage includes confirmation, refusal, replay, expiry, permission changes,
cross-connection isolation, cancellation during final ownership reads, batch
limits and confirmation replies under full tool capacity. Browser approval is
refused while a native confirmation is open; browser cancellation remains available.

Validation also covers compilation, formatting, Python checks, dependency audit,
plugin manifests and package integrity. The deployment process checks the built
image without networking and tests an upgrade against an isolated copy of the
encrypted store. Private credentials, account identifiers, provider responses
and operator records are excluded from the public source and release assets.

## What this establishes

Fixture tests exercise the protocol and lifecycle under controlled conditions.
Package checks establish which files and checksums were released. Live checks
establish the observed service version, HTTPS metadata and download availability.
These are separate kinds of evidence.

Prior live qualification covered scoped DNS and mailbox operations, a disposable
stateless app deployment and rollback, and authenticated documentation reads.
Fresh Claude web consent and Codex OAuth/model calls passed on 0.3.2. Those results
do not establish usable native confirmation in every client on 0.3.3.

For current, version-bound client evidence, use
[/clients](https://infomaniak-mcp.com/clients). Fresh installs, a client-rendered
confirmation and an end-to-end write must be qualified for each advertised
client. Directory publication is a separate review process.

## Reproduce locally

```sh
npm ci --ignore-scripts
npm test
npm run format:check
python3 -m unittest discover -s tests -p 'test_*.py'
npm audit --omit=dev
```

Tests use temporary stores and fake credentials. Do not load real provider
credentials, SSH configuration or live resource settings into fixture runs.
See [testing.md](testing.md) for live-test boundaries and
[reviewer-testing.md](reviewer-testing.md) for the directory review cases.
