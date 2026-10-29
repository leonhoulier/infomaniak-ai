import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { HostedStore } from "../dist/hosted-store.js";
import { createHostedAnalytics } from "../dist/hosted-analytics.js";
import { PostHog } from "posthog-node";
import { gunzipSync } from "node:zlib";

test("the real SDK sends only anonymous count properties through the supplied transport", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ik-analytics-sdk-"));
  const store = new HostedStore(directory, randomBytes(32));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const sent = [];
  const analytics = createHostedAnalytics(
    store,
    { POSTHOG_PROJECT_TOKEN: "phc_fixture", POSTHOG_HOST: "https://eu.i.posthog.com" },
    (token, options) =>
      new PostHog(token, {
        ...options,
        fetch: async (url, request) => {
          assert.equal(new URL(url).origin, "https://eu.i.posthog.com");
          if (request.body) {
            const raw = Buffer.from(request.body);
            const data = JSON.parse(
              (raw[0] === 31 && raw[1] === 139 ? gunzipSync(raw) : raw).toString(),
            );
            sent.push(...(data.batch ?? [data]));
          }
          return {
            status: 200,
            text: async () => '{"status":1}',
            json: async () => ({ status: 1 }),
          };
        },
      }),
  );
  analytics.record("tool_completed", "infomaniak_read");
  await analytics.shutdown();
  const captured = sent.find((e) => e.event === "tool_completed");
  assert(captured);
  assert.equal(captured.properties.$process_person_profile, false);
  assert.equal(captured.properties.$geoip_disable, true);
  assert.equal(captured.properties.tool, "infomaniak_read");
  assert(
    !Object.keys(captured.properties).some((k) =>
      /email|account|domain|token|url|request|error|^\$ip$/.test(k),
    ),
  );
});

test("analytics has no request data surface, rejects unknown tools and persists its daily budget", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ik-analytics-"));
  let now = Date.parse("2026-10-27T12:00:00Z");
  const key = randomBytes(32),
    captured = [];
  let store = new HostedStore(directory, key, () => now);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const env = { POSTHOG_PROJECT_TOKEN: "phc_fixture", POSTHOG_HOST: "https://eu.i.posthog.com" };
  const factory = () => ({
    on() {},
    capture(event) {
      captured.push(event);
    },
    async shutdown() {},
  });
  const disabled = createHostedAnalytics(store, {}, () => {
    throw Error("must not initialize");
  });
  assert.equal(disabled, undefined);
  assert.throws(() =>
    createHostedAnalytics(store, { ...env, POSTHOG_HOST: "https://untrusted.example" }, factory),
  );
  let analytics = createHostedAnalytics(store, env, factory);
  analytics.record("tool_completed", "private-credential-or-unknown-tool");
  analytics.record("unexpected-private-event");
  assert.equal(captured.length, 0);
  analytics.record("tool_completed", "infomaniak_read");
  assert.deepEqual(captured[0].properties, {
    $process_person_profile: false,
    service: "infomaniak-mcp",
    tool: "infomaniak_read",
  });
  assert.match(captured[0].distinctId, /^[a-f0-9-]{36}$/);
  for (let i = 0; i < 1100; i++) analytics.record("homepage_viewed");
  assert.equal(captured.length, 1000);
  assert.equal(new Set(captured.map((e) => e.distinctId)).size, 1000);
  await analytics.shutdown();
  store.close();
  store = new HostedStore(directory, key, () => now);
  analytics = createHostedAnalytics(store, env, factory);
  analytics.record("homepage_viewed");
  assert.equal(captured.length, 1000);
  now += 86_400_000;
  analytics.record("homepage_viewed");
  assert.equal(captured.length, 1001);
  await analytics.shutdown();
});

test("analytics transport failure does not interrupt the application", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ik-analytics-failure-"));
  const store = new HostedStore(directory, randomBytes(32));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const analytics = createHostedAnalytics(
    store,
    { POSTHOG_PROJECT_TOKEN: "phc_fixture", POSTHOG_HOST: "https://eu.i.posthog.com" },
    () => ({
      on() {},
      capture() {
        throw Error("private transport response");
      },
      async shutdown() {
        throw Error("private shutdown error");
      },
    }),
  );
  assert.doesNotThrow(() => analytics.record("connection_disconnected"));
  await assert.doesNotReject(analytics.shutdown());
});
