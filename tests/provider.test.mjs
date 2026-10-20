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
    // The shape /1/products and /1/mail_hostings/{id}/mailboxes actually return.
    { result: "success", data: [], page: 1, pages: 2, items_per_page: 15, total: 18 },
  ]) {
    const api = new PublicApi("fixture", new RequestQueue(0), async () => Response.json(data));
    await assert.rejects(api.request("GET", "/2/x"), { code: "incomplete_response" });
  }
});
test("a single complete Infomaniak page is accepted", async () => {
  const api = new PublicApi("fixture", new RequestQueue(0), async () =>
    Response.json({ result: "success", data: [1], page: 1, pages: 1, total: 1 }),
  );
  assert.deepEqual(await api.request("GET", "/1/products"), [1]);
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
test("rejections carry Infomaniak's error code but never its description", async () => {
  const api = new PublicApi("fixture-secret", new RequestQueue(0), async () =>
    Response.json(
      {
        result: "error",
        error: { code: "alias_does_not_exist", description: "echo fixture-secret" },
      },
      { status: 400 },
    ),
  );
  await assert.rejects(api.request("DELETE", "/1/mail_hostings/1/mailboxes/a/aliases/b"), (e) => {
    assert.equal(e.code, "provider_error");
    assert.equal(e.upstream, "alias_does_not_exist");
    assert.match(e.message, /HTTP 400\. Infomaniak code: alias_does_not_exist\./);
    assert(!e.message.includes("fixture-secret"));
    return true;
  });
  const odd = new PublicApi("fixture", new RequestQueue(0), async () =>
    Response.json({ error: { code: "Bearer abc; drop" } }, { status: 403 }),
  );
  await assert.rejects(odd.request("GET", "/2/x"), (e) => e.upstream === undefined);
});
