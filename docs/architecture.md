# Architecture

```text
AI client + portable skill
        |
        | MCP: status / search / read
        v
Infomaniak AI gateway
  input validation, explicit account selection,
  reviewed read allowlist, redaction, response budgets
        |
        | MCP stdio, selected file + checksum
        v
Reviewed infomaniak-mcp-agent build
  narrow child environment, Manager auth disabled,
  preloaded GET-only fetch guard
        |
        v
Public Infomaniak API / approved DNS reads
```

## Why an independent layer

The provider MCP should implement resource schemas and HTTP behavior. The plugin
should coordinate user outcomes across resources and keep client installation and
workflow guidance out of the provider library. Neither layer should contain a
custom container scheduler merely to offer application deployment.

An adapter interface isolates the plugin from the current MCP implementation.
Tool discovery is on demand, and unknown or unavailable operations fail closed.
The current API contract has no generic execution route or arbitrary server/path
argument supplied by the model.

## Current decisions

- Local stdio first. No hosted auth service or remote tenancy claims.
- Explicit backend path and checksum while a stable reviewed distribution is
  unavailable. The pin covers the entry file, not the full dependency graph.
- Read-only hints are required but insufficient; the fixed reviewed list also
  applies. Original Manager-only VPS inventory is hidden unless the reviewed
  token-support companion capability is present.
- Account-scoped listing schemas require `account_id`, including when the backend
  marks it optional. Child resources use explicit provider identifiers and the
  provider's own resource permissions. This is not a tenant-isolation boundary.
- The GET guard covers the reviewed backend's fetch client. It does not sandbox a
  deliberately malicious executable or other tools in the host.
- No raw adapter stderr or exceptions are forwarded. Configured token values and
  common credential fields are redacted from data and upstream errors. No redactor
  can promise to identify every unknown secret in arbitrary content.
- Catalogue pagination is bounded and rejects repeated cursors or duplicate
  names. Read arguments and responses have explicit size budgets.
- Errors remain MCP errors, with stable codes in text content. The gateway does
  not attach a success-shaped structured payload to a failure.

## Next deployment boundary

Add one typed release adapter for an existing managed Node.js application or an
established VPS release engine such as Coolify. Preserve the Infomaniak MCP for
account, DNS and mail resource operations. Evaluate supported auth and real release
semantics before choosing the first adapter.

The application workflow should model:

```text
inspect -> plan -> host approval -> execute -> observe -> verify
                                  |                    |
                                  v                    v
                           unknown outcome        verified release
                                  |                    |
                              reconcile        promote / restore
```

Approval belongs to the host/runtime and binds the exact plan, project,
environment and current resource state. It cannot be created by the same model
that requests execution. Retrying an uncertain mutation requires reconciliation.
Restoration must identify a previously verified immutable release; an API request
returning success is not proof that a deployment or rollback completed.

The first end-to-end test must use a disposable application, separate preview
hostname and non-production dependencies. No agent-selected arbitrary SSH or shell
commands are required to implement a release adapter.
