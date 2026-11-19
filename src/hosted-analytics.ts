import { randomUUID } from "node:crypto";
import { PostHog, type PostHogOptions } from "posthog-node";
import { fingerprint, type HostedStore } from "./hosted-store.js";

const events = [
  "homepage_viewed",
  "guide_viewed",
  "connection_started",
  "setup_token_accepted",
  "setup_token_rejected",
  "connection_approved",
  "connection_activated",
  "connection_disconnected",
  "tool_completed",
  "tool_failed",
  "write_verified",
  "write_not_verified",
] as const;
export type Event = (typeof events)[number];
const tools = new Set([
  "infomaniak_status",
  "infomaniak_search",
  "infomaniak_catalogue",
  "infomaniak_read",
  "infomaniak_plan",
  "infomaniak_execute",
  "infomaniak_operation",
  "infomaniak_cancel",
  "infomaniak_docs_search",
  "infomaniak_docs_read",
]);
/** Fixed hosted read operations. Anything else is reported as "other", never echoed. */
const operations = new Set([
  "accounts.list",
  "products.list",
  "resources.resolve",
  "dns.records.list",
  "dns.audit",
  "dns.propagation",
  "domains.expiry",
  "mail.mailbox.get",
  "mail.aliases.list",
  "mail.forwarding.get",
  "deployment.app.get",
  "deployment.runner.health",
  "deployment.logs",
  "deployment.job.get",
]);
const allowed = {
  access: new Set(["read_only", "resources", "disposable_dns"]),
  kind: new Set(["dns", "mail", "deployment", "other"]),
  state: new Set(["failed", "unknown"]),
  guide: new Set(["claude-code", "dns-records", "vps-deploy"]),
  lang: new Set(["en", "fr"]),
};
export interface Detail {
  access?: string;
  operation?: string;
  kind?: string;
  state?: string;
  guide?: string;
  lang?: string;
}
export interface HostedAnalytics {
  record(event: Event, tool?: string, detail?: Detail): void;
  /** Record an event at most once per subject until `expires`. */
  once?(event: Event, subject: string, expires: number, detail?: Detail): void;
  /** True when a configured operator/reviewer account is involved. */
  excludes?(accounts: readonly number[]): boolean;
  /** Mark one connection active this ISO week; closed weeks are sent once as a total. */
  active?(connection: string): void;
  shutdown(): Promise<void>;
}

const DAY = 86_400_000;
const WEEK_CAP = 10_000;
/** ISO 8601 week label and its UTC start, e.g. 2026-W47. */
export function isoWeek(ms: number): { label: string; start: number } {
  const date = new Date(ms),
    day = (date.getUTCDay() + 6) % 7,
    start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - day * DAY,
    thursday = new Date(start + 3 * DAY),
    year = thursday.getUTCFullYear(),
    week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY)) + 1;
  return { label: year + "-W" + String(week).padStart(2, "0"), start };
}
function sanitize(detail: Detail = {}): Record<string, string> {
  const result: Record<string, string> = {};
  if (detail.operation !== undefined)
    result.operation = operations.has(detail.operation) ? detail.operation : "other";
  for (const key of ["access", "kind", "state", "guide", "lang"] as const) {
    const value = detail[key];
    if (value !== undefined && allowed[key].has(value)) result[key] = value;
  }
  return result;
}
/** Comma-separated positive account IDs, kept in the private operator environment. */
export function parseExcludedAccounts(value: string | undefined): Set<number> | undefined {
  const text = value?.trim() ?? "";
  if (!text) return new Set();
  const parts = text.split(",").map((part) => part.trim());
  if (
    parts.length > 100 ||
    parts.some((part) => !/^[1-9][0-9]{0,15}$/.test(part) || !Number.isSafeInteger(Number(part)))
  )
    return undefined;
  return new Set(parts.map(Number));
}

/**
 * Counts only. No stable visitor ID, account ID, request, credential, payload or
 * error text enters PostHog. Dedupe and weekly state stay in the encrypted
 * hosted store under one-way identifiers and expire.
 */
export function createHostedAnalytics(
  store: HostedStore,
  env: NodeJS.ProcessEnv = process.env,
  clientFactory = (token: string, options: PostHogOptions) => new PostHog(token, options),
): HostedAnalytics | undefined {
  const token = env.POSTHOG_PROJECT_TOKEN?.trim(),
    host = env.POSTHOG_HOST?.trim();
  if (!token || !host) return;
  if (!/^phc_[A-Za-z0-9_-]+$/.test(token) || host !== "https://eu.i.posthog.com")
    throw new Error("Invalid hosted analytics configuration.");
  const excluded = parseExcludedAccounts(env.INFOMANIAK_ANALYTICS_EXCLUDED_ACCOUNTS);
  if (!excluded) {
    // Never send unfiltered counts when the operator asked for an exclusion.
    console.error("Analytics disabled: invalid INFOMANIAK_ANALYTICS_EXCLUDED_ACCOUNTS.");
    return;
  }
  const client = clientFactory(token, {
    host,
    disableGeoip: true,
    enableExceptionAutocapture: false,
    enableLocalEvaluation: false,
    disableRemoteFeatureFlags: true,
    flushAt: 10,
    flushInterval: 10_000,
    maxQueueSize: 100,
    requestTimeout: 2000,
    fetchRetryCount: 0,
  });
  client.on("error", () => {});
  const send = (event: string, properties: Record<string, unknown>) =>
    client.capture({
      distinctId: randomUUID(),
      event,
      properties: { $process_person_profile: false, service: "infomaniak-mcp", ...properties },
    });
  /** Returns true only when the event was accepted for sending. */
  function capture(event: Event, tool?: string, detail?: Detail): boolean {
    if (!events.includes(event) || (tool !== undefined && !tools.has(tool))) return false;
    const day = new Date(store.now()).toISOString().slice(0, 10);
    const count = store.get<number>("analytics-budget", day) ?? 0;
    if (count >= 1000) return false;
    store.put("analytics-budget", day, count + 1, Date.parse(day) + 2 * DAY);
    send(event, { ...(tool ? { tool } : {}), ...sanitize(detail) });
    return true;
  }
  let flushedWeek = "";
  /** Send each closed week's total once. Rows are deleted in the same transaction. */
  function flushClosedWeeks(): void {
    const current = isoWeek(store.now()).label;
    if (flushedWeek === current) return;
    const totals = store.atomic(() => {
      const closed = store
        .list<{ count: number; capped: boolean }>("analytics-week")
        .filter((row) => row.id < current);
      if (!closed.length) return [];
      const weeks = new Set(closed.map((row) => row.id));
      for (const row of store.list("analytics-active"))
        if (weeks.has(row.id.slice(0, row.id.indexOf(":"))))
          store.delete("analytics-active", row.id);
      for (const row of closed) store.delete("analytics-week", row.id);
      return closed;
    });
    flushedWeek = current;
    // One aggregate per week; outside the daily event cap so a busy day cannot drop it.
    for (const { id, value } of totals)
      send("weekly_active_connections", {
        week: id,
        connections: value.count,
        capped: value.capped,
      });
  }
  const guard = (run: () => void) => {
    try {
      run();
    } catch {
      /* Analytics never prevents consent, reads, writes or disconnection. */
    }
  };
  return {
    record(event, tool, detail) {
      guard(() => {
        flushClosedWeeks();
        capture(event, tool, detail);
      });
    },
    once(event, subject, expires, detail) {
      guard(() => {
        const now = store.now();
        if (!Number.isSafeInteger(expires) || expires <= now) return;
        const id = fingerprint(event + ":" + subject);
        if (store.get("analytics-once", id) !== undefined) return;
        if (capture(event, undefined, detail))
          store.put("analytics-once", id, 1, Math.min(expires, now + 32 * DAY));
      });
    },
    excludes(accounts) {
      return accounts.some((account) => excluded.has(account));
    },
    active(connection) {
      guard(() => {
        flushClosedWeeks();
        const { label, start } = isoWeek(store.now()),
          id = label + ":" + fingerprint(label + ":" + connection),
          expires = start + 21 * DAY;
        store.atomic(() => {
          if (store.get("analytics-active", id) !== undefined) return;
          const week = store.get<{ count: number; capped: boolean }>("analytics-week", label) ?? {
            count: 0,
            capped: false,
          };
          if (week.count >= WEEK_CAP) week.capped = true;
          else {
            store.put("analytics-active", id, 1, expires);
            week.count++;
          }
          store.put("analytics-week", label, week, expires);
        });
      });
    },
    async shutdown() {
      try {
        await client.shutdown(2500);
      } catch {}
    },
  };
}
