# What to learn from Cloudflare's agent experience

Research: 28 October 2026. Dashboard observations are separate from vendor
claims. No Cloudflare agent was installed, authorised or deployed in this review.

## What they offer

Cloudflare has two complementary products: tools for coding agents to operate
Cloudflare, and infrastructure on which developers build their own agents.

In the authenticated dashboard, “Onboard your agent to Cloudflare” names Claude,
Codex, Cursor and OpenCode. Clicking it reported a copied setup prompt. The
clipboard content was unavailable, so the exact prompt was not reviewed. Public
[setup guides](https://developers.cloudflare.com/agent-setup/) give each coding
tool its own installation path. Their
[agent documentation](https://developers.cloudflare.com/docs-for-agents/)
combines skills, machine-readable documentation and MCP access.

Their [managed MCP server](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)
provides search, execution and documentation tools over the Cloudflare API.
It uses scoped OAuth or bearer tokens, generated types and isolated execution.
Cloudflare claims coverage of more than 2,500 endpoints with a compact tool
interface. We did not benchmark its context savings or execute its tools.

The [Agents SDK](https://github.com/cloudflare/agents) adds a hosted runtime.
Its [MCP integration](https://developers.cloudflare.com/agents/tools/mcp/)
lets hosted agents connect to other services. Durable state, workflows and
tracing support long-running work. The current
[Think tool documentation](https://developers.cloudflare.com/agents/harnesses/think/tools/)
includes approval pauses and resume/reject operations. Approvals are therefore
not a capability unique to our product; support depends on the particular runtime
and tool integration.

The dashboard also exposes Ask AI, MCP Portals, Agent tracing and domain Agent
Readiness. Their presence is not evidence that they are configured or included
in the account's free plan. Markdown for Agents was shown as a Pro feature on
this domain. No paid feature was activated.

## Baseline before this implementation

Our hosted pilot has four read-only discovery tools, account consent and a
searchable public API catalogue. It does not yet offer hosted writes, guest SSH,
application deployment or a hosted agent runtime. Catalogue coverage is not
executable coverage. A stronger landing page cannot close that gap.

## Recommended order

1. **Prove the installation.** Complete and record fresh-account onboarding in
   each supported coding client. Finish with a real account inventory result.
   Describe untested clients as untested, even when they support standard MCP.
2. **Complete one useful write workflow.** Start with DNS inspection and one
   explicitly approved record change on a disposable domain: show the exact diff,
   protect mail records, read back the provider result and check propagation.
   Provide an explicit rollback plan; do not promise transactional rollback.
3. **Build the deployment path.** Inspect a VPS and domain, propose deployment,
   provision TLS, check the running application and retain rollback evidence.
   Separate Infomaniak product APIs from guest operating-system access. A public
   hosted service should not casually collect customers' root SSH keys. Evaluate
   a customer-owned, scoped deployment runner before implementing guest writes.
4. **Make discovery progressive.** Search, describe and select relevant operations
   rather than putting the whole API catalogue in every prompt. Do not add an
   unrestricted JavaScript executor merely to match a competitor's tool names.
5. **Return evidence with each operation.** Report the resource, exact change,
   approval, provider readback and remaining uncertainty. Distinguish accepted,
   propagating and healthy states. Keep sensitive operational traces separate
   from anonymous PostHog product counts.

The strongest position is practical: let people use their preferred AI coder
with Infomaniak, with service-specific knowledge and changes they can understand.
Competing with the entire Workers/Agents runtime would be a separate product.

## Progress after this review

On 28 October, the first write workflow was implemented: optional hosted TXT
create/update/delete at one consented disposable name, encrypted plans and
separate browser approval. The authorised live cycle restored all 23 original
records. TXT presentation quoting caused an honest pending result and was fixed
through read-only reconciliation. This provides Infomaniak-specific evidence;
it does not establish broad API, mail, VPS or agent-runtime parity.
