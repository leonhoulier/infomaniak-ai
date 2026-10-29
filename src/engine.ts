import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Backend } from "./backend.js";
import { authorize, type Principal } from "./access.js";
import { boundedResult, PluginError, redact } from "./errors.js";
import { Journal, type Plan } from "./journal.js";
import { ApiError, type Api } from "./provider.js";
import {
  canonical,
  fingerprint,
  inputSchema,
  requireOperation,
  type Args,
  type Operation,
} from "./registry.js";

const revision = (op: Operation) =>
  op.revision + ":" + fingerprint({ method: op.method, path: op.path, input: inputSchema(op) });
// Only readback of already-sent plans can use a known pre-Zod-4 contract.
// Old unsent plans still require recreation and a fresh independent approval.
const legacyReadbacks = z
  .object({
    version: z.literal("0.3.1"),
    operations: z.record(
      z.string(),
      z.object({ revision: z.string(), method: z.string(), path: z.string() }).strict(),
    ),
  })
  .strict()
  .parse(
    JSON.parse(
      readFileSync(new URL("../data/legacy-operation-revisions.json", import.meta.url), "utf8"),
    ),
  ).operations;
function planHash(
  p: Pick<Plan, "id" | "principal" | "operation" | "revision" | "args" | "change" | "expires_at">,
): string {
  const { id, principal, operation, revision, args, change, expires_at } = p;
  return fingerprint({ id, principal, operation, revision, args, change, expires_at });
}
export class Engine {
  private running = new Set<Promise<unknown>>();
  constructor(
    readonly journal: Pick<Journal, "get" | "create" | "transition">,
    private readonly principal: Principal,
    private readonly api: Api,
    private readonly secrets: readonly string[],
    private readonly backend?: Backend,
    private readonly operations?: ReadonlyMap<string, Operation>,
  ) {}
  private operation(name: string): Operation {
    if (!this.operations) return requireOperation(name);
    const op = this.operations.get(name);
    if (!op)
      throw new PluginError(
        "operation_denied",
        "This operation is unavailable for this connection.",
      );
    return op;
  }
  private arguments(op: Operation, input: unknown, write = false): Args {
    if (JSON.stringify(input).length > 32_000)
      throw new PluginError("invalid_input", "Arguments exceed the input budget.");
    const args = op.input.parse(input) as Args;
    authorize(this.principal, op.id, args.account_id, op.resource?.(args), write);
    return args;
  }
  async read(name: string, input: unknown): Promise<Record<string, unknown>> {
    const op = this.operation(name);
    if (op.write || !op.read)
      throw new PluginError("operation_denied", "This operation requires a write plan.");
    const args = this.arguments(op, input);
    return boundedResult(
      { operation: op.id, data: await op.read(this.api, args, this.principal, this.backend) },
      this.secrets,
    );
  }
  async plan(name: string, input: unknown): Promise<Plan> {
    const op = this.operation(name);
    if (!op.write || !op.inspect || !op.change)
      throw new PluginError("operation_denied", "Choose a reviewed mutation to create a plan.");
    const args = this.arguments(op, input, true);
    if (canonical(redact(args, this.secrets)) !== canonical(args))
      throw new PluginError(
        "secret_input_denied",
        "This operation cannot accept secret values. Use a dedicated secure credential workflow.",
      );
    const before = await op.inspect(this.api, args);
    const change = op.change(args, before);
    if (canonical(redact(change, this.secrets)) !== canonical(change))
      throw new PluginError(
        "secret_input_denied",
        "The plan contains sensitive values that this approval workflow cannot safely persist or expose.",
      );
    if (canonical(change.before) === canonical(change.after))
      throw new PluginError("no_change", "The resource already has the requested state.");
    if (JSON.stringify(change).length > 100_000)
      throw new PluginError(
        "response_too_large",
        "The write plan exceeds its state budget. Narrow the operation.",
      );
    // Fail before persistence if the complete preview cannot be returned safely.
    boundedResult({ arguments: args, change }, this.secrets);
    const now = Date.now();
    const p = {
      id: randomUUID(),
      principal: this.principal.id,
      operation: op.id,
      revision: revision(op),
      args,
      change,
      state: "planned" as const,
      created_at: now,
      updated_at: now,
      expires_at: now + 10 * 60_000,
    };
    return this.journal.create({ ...p, hash: planHash(p) });
  }
  execute(id: string, hash: string, signal?: AbortSignal): Promise<Plan> {
    const task = this.executeOnce(id, hash, signal);
    this.running.add(task);
    void task.finally(() => this.running.delete(task)).catch(() => undefined);
    return task;
  }
  private validated(
    id: string,
    hash?: string,
    readback = false,
  ): { plan: Plan; op: Operation; args: Args } {
    const plan = this.journal.get(id, this.principal.id);
    const op = this.operation(plan.operation),
      args = this.arguments(op, plan.args, true);
    const legacy = legacyReadbacks[op.id];
    const knownLegacyReadback =
      readback &&
      ["pending", "unknown"].includes(plan.state) &&
      legacy?.revision === plan.revision &&
      legacy.method === op.method &&
      legacy.path === op.path &&
      plan.revision.startsWith(op.revision + ":");
    if (
      plan.hash !== planHash(plan) ||
      (hash !== undefined && plan.hash !== hash) ||
      (plan.revision !== revision(op) && !knownLegacyReadback)
    )
      throw new PluginError(
        "plan_mismatch",
        "Operation definition or plan changed; create a new plan.",
      );
    return { plan, op, args };
  }
  private async executeOnce(id: string, hash: string, signal?: AbortSignal): Promise<Plan> {
    const { plan, op, args } = this.validated(id, hash);
    if (plan.expires_at <= Date.now())
      throw new PluginError(
        "plan_expired",
        "The plan has expired. Create a new plan from current state.",
      );
    if (plan.state !== "approved")
      throw new PluginError(
        "approval_required",
        "A separate human approval is required. A plan ID or model-supplied token is insufficient.",
      );
    if (signal?.aborted)
      return this.journal.transition(id, this.principal.id, ["approved"], "cancelled", {
        outcome: "Cancelled before execution. No provider mutation was sent.",
      });
    if (!op.inspect || !op.change)
      throw new PluginError("operation_denied", "This operation has no reviewed write path.");
    this.journal.transition(
      id,
      this.principal.id,
      ["approved"],
      "executing",
      {},
      plan.change.resource,
    );
    let sent = false;
    try {
      const before = await op.inspect(this.api, args);
      if (fingerprint(before) !== fingerprint(plan.change.before))
        return this.journal.transition(id, this.principal.id, ["executing"], "stale", {
          outcome: "State changed since approval. No mutation was sent; create a fresh plan.",
        });
      const fresh = op.change(args, before);
      if (canonical(fresh) !== canonical(plan.change))
        throw new PluginError(
          "plan_mismatch",
          "The requested effects differ from the approved plan.",
        );
      this.arguments(op, args, true);
      const remaining = plan.expires_at - Date.now();
      if (remaining <= 0)
        throw new PluginError(
          "plan_expired",
          "The plan expired during preflight. No mutation was sent.",
        );
      if (signal?.aborted)
        throw new PluginError(
          "request_cancelled",
          "Cancelled during preflight. No provider mutation was sent.",
        );
      const { method, path, body } = fresh.request;
      const deadline = AbortSignal.timeout(remaining);
      const executionSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      sent = true;
      await this.api.request(method, path, body, executionSignal, { planId: id });
      this.journal.transition(id, this.principal.id, ["executing"], "pending", {
        outcome: "Request accepted; resource verification is required.",
      });
    } catch (error) {
      const uncertain = sent && (!(error instanceof ApiError) || error.uncertain);
      return this.journal.transition(
        id,
        this.principal.id,
        ["executing"],
        uncertain ? "unknown" : "failed",
        {
          outcome: uncertain
            ? "Request outcome is uncertain. No automatic retry; inspect and reconcile."
            : "Request did not complete successfully. Inspect current state before a new plan.",
        },
      );
    }
    return this.reconcile(id);
  }
  /** Validate the exact contract and current permissions before presenting an approval. */
  review(id: string, hash: string): Plan {
    const { plan } = this.validated(id, hash);
    if (plan.expires_at <= Date.now())
      throw new PluginError(
        "plan_expired",
        "The plan expired. Create a fresh preview from current state.",
      );
    return plan;
  }
  async reconcile(id: string): Promise<Plan> {
    const { plan, op, args } = this.validated(id, undefined, true);
    if (!["pending", "unknown"].includes(plan.state)) return plan;
    try {
      const actual = await op.inspect!(this.api, args, plan.id);
      const matches = op.matches ?? ((a: unknown, b: unknown) => canonical(a) === canonical(b));
      if (matches(actual, plan.change.after))
        return this.journal.transition(id, this.principal.id, ["pending", "unknown"], "verified", {
          outcome:
            "The provider resource matches the approved desired state. This does not establish DNS propagation or application health.",
        });
      return this.journal.transition(id, this.principal.id, ["pending", "unknown"], plan.state, {
        outcome:
          "Desired state is not verified. The operation remains locked; do not resend the mutation.",
      });
    } catch {
      return this.journal.transition(id, this.principal.id, ["pending", "unknown"], plan.state, {
        outcome: "Readback failed. Outcome remains unverified; no mutation was retried.",
      });
    }
  }
  cancel(id: string): Plan {
    return this.journal.transition(id, this.principal.id, ["planned", "approved"], "cancelled", {
      outcome: "Cancelled before execution.",
    });
  }
  status(id: string): Plan {
    return this.journal.get(id, this.principal.id);
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.running]);
  }
}
