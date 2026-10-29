# Claude Desktop bundle

`npm run package:desktop` builds `artifacts/infomaniak-ai-0.2.0.mcpb`.
It includes the compiled server and locked production dependencies. Installers
need no npm commands. The host supplies its Node runtime (22.13 or later).
The archive is unsigned; it is not a marketplace release.

`python3 scripts/desktop-smoke.py` checks its bundled server and dependencies in
a clean Node container with networking disabled and a fake token. This is also
part of the container CI job.

The extension asks for one sensitive `api_token` setting. It starts only
read-only account/product discovery. A policy or VPS backend is not required.
Native installation and credential-store behavior still need a manual test in
Claude Desktop on each supported OS; schema validation is not that evidence.

`mcpb-manifest.schema.json` is the unmodified v0.3 schema distributed in
`@anthropic-ai/mcpb@2.1.2`, from the MIT-licensed
[official MCPB project](https://github.com/modelcontextprotocol/mcpb).
Its license is preserved in `SCHEMA-LICENSE`. This is validation data, not
execution policy. Build-time ZIP creation uses pinned `fflate`; validation uses
pinned AJV. No downloaded schema is executed or refreshed during setup.
