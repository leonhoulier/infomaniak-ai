import type { Plan } from "./journal.js";
import type { ToolInteraction } from "./protocol.js";
import type { HostedWriteJournal } from "./hosted-writes.js";
import { PluginError } from "./errors.js";
import { writePreview } from "./write-preview.js";

/** Approval can arrive only through the negotiated client's response, never tool arguments. */
export class NativeApproval {
  private pending = new Map<string, Plan>();
  constructor(private journal: HostedWriteJournal) {}
  async confirm(
    review: () => Plan,
    confirm: NonNullable<ToolInteraction["confirmWrite"]>,
    signal: AbortSignal,
    browserUrl: string,
  ): Promise<Plan> {
    const plan = review();
    if (plan.state === "approved") return plan;
    if (plan.state !== "planned")
      throw new PluginError("invalid_state", "Inspect this plan before another execution request.");
    if (this.pending.has(plan.id))
      throw new PluginError("approval_pending", "This exact plan already has a confirmation open.");
    if (
      [...this.pending.values()].some((p) => p.principal === plan.principal) ||
      [...this.pending.values()].filter((p) => p.args.account_id === plan.args.account_id).length >=
        2
    )
      throw new PluginError(
        "approval_pending",
        "Finish the open confirmation before requesting another for this connection or account.",
      );
    const preview = writePreview(plan);
    // Never shorten a review: a client dialog must show the entire proposed effect.
    if (Buffer.byteLength(preview) > 12_000)
      throw new PluginError("approval_required", "Use the complete browser review: " + browserUrl);
    this.pending.set(plan.id, plan);
    try {
      let decision: "accept" | "decline" | "cancel";
      try {
        decision = await confirm(preview, Math.min(5 * 60_000, plan.expires_at - Date.now()));
      } catch {
        throw new PluginError(
          "confirmation_unavailable",
          "No change was approved. Retry confirmation or use " + browserUrl,
        );
      }
      if (signal.aborted)
        throw new PluginError(
          "confirmation_cancelled",
          "The request ended. No change was approved.",
        );
      // Re-read the grant, permissions, contract, state, hash and expiry after human interaction.
      const current = review();
      if (decision !== "accept" && ["planned", "approved"].includes(current.state))
        return this.journal.transition(
          plan.id,
          plan.principal,
          ["planned", "approved"],
          "cancelled",
          {
            outcome: "Declined in the client confirmation. No provider mutation was sent.",
          },
        );
      if (current.state !== "planned")
        throw new PluginError(
          "invalid_state",
          "This plan changed while confirmation was open. Inspect it before proceeding.",
        );
      return this.journal.approve(plan.id, plan.principal, plan.hash);
    } finally {
      this.pending.delete(plan.id);
    }
  }
}
