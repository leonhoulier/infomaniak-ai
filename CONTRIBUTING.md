# Contributing

Keep provider fixes in the upstream MCP where possible. This repository owns the
plugin interface, capability policy, skills and cross-product workflows.

```sh
npm ci --ignore-scripts
npm test
npm run format:check
```

Use one concern per change. Keep dependency versions and the lockfile in sync.
Fixture tests must work without credentials and must not load a user's API config,
browser cookies or SSH configuration. Live evidence stays outside the repository.

To admit a read, review its backend handler and transport, add it to the explicit
allowlist, and test failure paths. A `readOnlyHint` or a name beginning with `get`
does not establish safety. Dynamic generic API or shell execution is outside scope.

Mutation workflows need an execution/approval design and a disposable test target
before implementation. A model-visible confirmation token is insufficient.
Document independent approval, unknown outcomes, readback and restoration.
Follow [API coverage and write policy](docs/api-coverage.md): importing documented
routes does not admit them to execution, and fixture coverage is not live validation.

Run the native Claude Code manifest validator when changing plugin metadata:

```sh
claude plugin validate .
```

Do not commit secrets, real account fixtures, generated build output or install
state. No generated-code footers or co-author trailers are added automatically.
