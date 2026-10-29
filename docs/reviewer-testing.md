# Directory review test plan

Candidate: 0.3.5. These are reproducible review cases, not a claim that a portal
review or a fresh workflow in every client has passed. Current evidence is at
[/clients](https://infomaniak-mcp.com/clients).

## Review account

Provision a dedicated Infomaniak account with a disposable domain and existing
mailbox. Optionally provide a dedicated VPS runner with one stateless HTTP app.
Do not give reviewers the operator's production account or a shared provider
token. Provide credentials only through the directory's private reviewer fields.
The reviewer enters the provider token on the service's consent page, not in
chat, a prompt, the archive or MCP configuration.

Record the client version, plugin checksum, live service version and UTC test
time for each run. Revoke the test connection and remove test resources afterward.
An archive upload, OAuth callback, model-driven tool call and verified provider
effect each require their own evidence.

## Five positive cases

1. **Private connection and discovery.** Install the appropriate ZIP, connect
   through OAuth, choose the review account and read-only access. Ask “Show the
   services this connection can access.” Expect only that account's products,
   no provider credential in tool results and no write tools for this grant.
2. **DNS change and cleanup.** Reconnect with DNS access to the disposable
   domain. Ask for one TXT record at `_mcp-review` with value `review-0.3.5`.
   Inspect the complete account, DNS zone, record name and before/after plan.
   For `approval_method: client`, call execute and confirm in the client’s own
   dialog; otherwise approve in the consenting browser before execution. Read back. Update the test value through a
   new approved plan, then remove only the test record through another plan.
   Expect `verified` provider readback. Public propagation is a separate check.
3. **Mailbox alias.** Grant one disposable existing mailbox. Read its aliases,
   plan one unused alias, approve, execute and verify the alias list. Remove the
   new alias through a separate approved plan. Expect the original aliases and
   delivery settings preserved; no email content is available.
4. **VPS release and recovery.** Pair the dedicated runner after reviewing its
   repository, app and hostname. Deploy an exact Git commit through a reviewed
   plan. Expect a signed completion from that plan's job and a fresh healthy app
   report before `verified`. Deploy a second commit, then prepare and approve
   rollback to the retained image. Database changes are outside this workflow.
5. **Current official documentation.** Ask for Infomaniak's current VPS SSH guide.
   Search, read an official result and request the next page if truncated.
   Expect source URL and retrieval time. The answer must distinguish documented
   Manager steps from actions actually performed. Documentation grants no
   permission to make browser changes.

## Three negative cases

1. **Outside the grant.** Request another account, an unconsented DNS domain or
   mailbox. Expect access denial before any provider mutation. Resource IDs
   cannot override the consent boundary.
2. **Unapproved or modified plan.** On a native-capable client, request execution and decline the dialog;
   expect cancellation with no mutation. On the browser fallback, try execution
   before approval and expect denial. Try a different plan hash and expect refusal
   before a prompt or mutation. A model-supplied plan ID or acknowledgement cannot approve it.
3. **Changed or uncertain state.** In the disposable environment, change the
   resource after approval or simulate a lost provider response. Expect `stale`
   before sending when state changed, or `unknown` with a retained lock after an
   uncertain send. Reconcile using reads; never automatically resend. Operator
   abandonment requires offline manual investigation and remains unverified.

## Evidence required before submission

- A dedicated reviewer account and safe resources, with working private access.
- Completed positive and negative cases in the intended client, including
  approval rejection, verification and disconnect.
- A walkthrough showing the actual installation, consent and reviewed change.
- Publisher/domain verification, portal validation and resolved scan results.
- Public source, runtime download and deployed build matching the submitted ZIP.

The repository's fixture tests cover account isolation, approval binding,
conflicts, uncertain readback, signed runner jobs and recovery. They complement
these client checks; they do not replace them.
