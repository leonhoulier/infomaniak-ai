# Small contributions to start with

Open one focused issue/PR per task. Run fixture checks without an Infomaniak
account. Do not add customer records or claim a client flow passed without
actually completing it.

1. **Improve one French guide.** Review terminology and instructions against the
   English equivalent in `src/hosted-guides.ts`. Keep actual command and interface
   labels literal. Check reciprocal language links with `tests/growth-pages.test.mjs`.
2. **Record one client compatibility result.** Follow `docs/reviewer-testing.md`
   with your own account and a designated disposable resource. Report the exact
   client/version, service version and steps that passed or failed. Redact IDs,
   domains and credentials. Installation, OAuth, reads, approval, verification
   and disconnect are separate evidence.
3. **Add a DNS audit fixture.** In `tests/diagnostics.test.mjs`, add a
   synthetic case for a documented edge condition in `auditRecords`. Explain
   why the expected finding matters and link the official source. An audit
   finding must not trigger an automatic DNS change.

See [CONTRIBUTING](../CONTRIBUTING.md) for operation admission and write tests.
