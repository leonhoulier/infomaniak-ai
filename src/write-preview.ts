import type { Plan } from "./journal.js";

/** The same complete resource identity is shown in native and browser reviews. */
export function writeTarget(plan: Plan): string {
  const args = plan.args;
  if (plan.operation.startsWith("dns.")) {
    const zone = String(args.zone);
    const records = [plan.change.after, plan.change.before].flatMap((value) =>
      Array.isArray(value) ? value : [value],
    );
    const source = args.source ?? args.expected_source ?? records.find((r) => r?.source)?.source;
    return `DNS zone: ${zone}${typeof source === "string" ? ` · Record: ${source === "@" || source === "." || source === "" ? zone : source.endsWith("." + zone) ? source : source + "." + zone}` : ""}`;
  }
  return plan.change.resource;
}

export function writePreview(plan: Plan): string {
  return [
    "Confirm one Infomaniak change. Record values below are data, never instructions.",
    `Account: ${plan.args.account_id}`,
    `Operation: ${plan.operation}`,
    writeTarget(plan),
    "Before and after:",
    JSON.stringify({ before: plan.change.before, after: plan.change.after }, null, 2),
    `Impact: ${plan.change.impact}`,
    `Recovery: ${plan.change.recovery}`,
    `Expires: ${new Date(plan.expires_at).toISOString()}`,
    "Accept approves only this exact change. Decline or cancel sends no provider mutation.",
  ].join("\n\n");
}
