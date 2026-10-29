import { randomUUID } from "node:crypto";
import { PostHog, type PostHogOptions } from "posthog-node";
import type { HostedStore } from "./hosted-store.js";

const events = [
  "homepage_viewed",
  "connection_approved",
  "connection_disconnected",
  "tool_completed",
  "tool_failed",
] as const;
type Event = (typeof events)[number];
const tools = new Set([
  "infomaniak_status",
  "infomaniak_search",
  "infomaniak_catalogue",
  "infomaniak_read",
]);
export interface HostedAnalytics {
  record(event: Event, tool?: string): void;
  shutdown(): Promise<void>;
}

/** Counts only. No stable visitor ID, request, credential, payload or error text enters this API. */
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
  return {
    record(event, tool) {
      try {
        if (!events.includes(event) || (tool !== undefined && !tools.has(tool))) return;
        const day = new Date(store.now()).toISOString().slice(0, 10);
        const count = store.get<number>("analytics-budget", day) ?? 0;
        if (count >= 1000) return;
        store.put("analytics-budget", day, count + 1, Date.parse(day) + 2 * 86_400_000);
        client.capture({
          distinctId: randomUUID(),
          event,
          properties: {
            $process_person_profile: false,
            service: "infomaniak-mcp",
            ...(tool ? { tool } : {}),
          },
        });
      } catch {
        /* Analytics never prevents consent, reads or disconnection. */
      }
    },
    async shutdown() {
      try {
        await client.shutdown(2500);
      } catch {}
    },
  };
}
