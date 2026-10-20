import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicApi, RequestQueue } from "../dist/provider.js";

test("typed public transport sends fixed origin/auth with redirect rejection and no browser credentials", async () => {
  const calls = [];
  const api = new PublicApi("fixture-token", new RequestQueue(0), async (url, options) => {
    calls.push({ url: String(url), ...options });
    return Response.json({ result: "success", data: { ok: true } });
  });
  assert.deepEqual(
    await api.request("POST", "/2/zones/example.com/records", { target: "192.0.2.1" }),
    { ok: true },
  );
  assert.equal(calls[0].url, "https://api.infomaniak.com/2/zones/example.com/records");
  assert.equal(calls[0].redirect, "error");
  assert.equal(calls[0].credentials, "omit");
  for (const path of [
    "//evil.example/2/x",
    "https://evil.example",
    "/2/x#fragment",
    "/2/x\\escape",
  ])
    await assert.rejects(api.request("POST", path, {}), { code: "transport_denied" });
  assert.equal(calls.length, 1);
});
test("transport never retries rejected or uncertain mutations and suppresses provider error bodies", async () => {
  for (const status of [403, 500]) {
    let calls = 0;
    const api = new PublicApi("fixture-secret", new RequestQueue(0), async () => {
      calls++;
      return new Response('{"secret":"fixture-secret"}', { status });
    });
    await assert.rejects(api.request("POST", "/2/zones/example.com/records", {}), (error) => {
      assert.equal(error.uncertain, status >= 500);
      assert(!error.message.includes("fixture-secret"));
      return true;
    });
    assert.equal(calls, 1);
  }
  let calls = 0;
  const api = new PublicApi("fixture", new RequestQueue(0), async () => {
    calls++;
    throw new Error("network");
  });
  await assert.rejects(api.request("PUT", "/2/x", {}), { code: "unknown_outcome" });
  assert.equal(calls, 1);
});
test("malformed success bodies and oversized responses preserve write uncertainty", async () => {
  for (const response of [
    () => new Response("bad json"),
    () => Response.json({ data: "x".repeat(1_000_001) }),
    () => Response.json({ result: "error", data: {} }),
  ]) {
    const api = new PublicApi("fixture", new RequestQueue(0), async () => response());
    await assert.rejects(api.request("DELETE", "/2/x"), { code: "unknown_outcome" });
  }
});
test("incomplete pagination cannot be silently accepted as a complete precondition", async () => {
  for (const data of [
    { data: [], has_more: true },
    { data: [], pagination: { current_page: 1, last_page: 2 } },
  ]) {
    const api = new PublicApi("fixture", new RequestQueue(0), async () => Response.json(data));
    await assert.rejects(api.request("GET", "/2/x"), { code: "incomplete_response" });
  }
});
test("the shared request queue serializes concurrent callers", async () => {
  const queue = new RequestQueue(0),
    events = [];
  let release;
  const first = queue.run(async () => {
    events.push("first");
    await new Promise((resolve) => {
      release = resolve;
    });
    events.push("first done");
  });
  const second = queue.run(async () => {
    events.push("second");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first", "first done", "second"]);
});
