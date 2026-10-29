import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { hostedFixture } from "./fixtures/hosted.mjs";
import { PluginError } from "../dist/errors.js";

async function connect(
  f,
  handler,
  capabilities = { elicitation: { form: {} } },
  access = f.access,
) {
  const client = new Client(
    { name: "native-confirmation-fixture", version: "1" },
    { capabilities },
  );
  if (handler) client.setRequestHandler(ElicitRequestSchema, handler);
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", f.origin), {
    requestInit: { headers: { authorization: "Bearer " + access } },
  });
  await client.connect(transport);
  return {
    client,
    transport,
    close: async () => {
      await client.close();
    },
  };
}
const tool = (client, name, args) => client.callTool({ name, arguments: args });
async function plan(client, target = "native-fixture") {
  const r = await tool(client, "infomaniak_plan", {
    operation: "dns.record.create",
    arguments: {
      account_id: 10,
      zone: "example.com",
      source: "_native-test",
      type: "TXT",
      target,
      ttl: 300,
    },
  });
  assert(!r.isError, JSON.stringify(r));
  return r.structuredContent;
}
const writes = (f) => f.api.calls.filter((c) => c.method !== "GET");
const execute = (client, p) =>
  tool(client, "infomaniak_execute", { plan_id: p.id, plan_hash: p.hash });
const code = (r) => JSON.parse(r.content[0].text).code;

test(
  "real HTTP native confirmation shows full identity, waits for the client, executes once and refuses replay",
  { timeout: 15000 },
  async (t) => {
    const f = await hostedFixture(t);
    let accept, prompted;
    const shown = new Promise((r) => (prompted = r)),
      decision = new Promise((r) => (accept = r));
    const c = await connect(f, async (request) => {
      prompted(request);
      return decision;
    });
    try {
      assert(c.transport.sessionId);
      const result = await plan(c.client);
      assert.equal(result.approval_method, "client");
      const running = execute(c.client, result.plan);
      const request = await shown;
      assert.equal(request.params.mode, "form");
      assert.match(
        request.params.message,
        /DNS zone: example\.com · Record: _native-test\.example\.com/,
      );
      assert.match(request.params.message, /native-fixture/);
      assert(!request.params.message.includes(f.grant.token));
      assert.equal(writes(f).length, 0);
      accept({ action: "accept", content: {} });
      const completed = await running;
      assert(!completed.isError, JSON.stringify(completed));
      assert.equal(completed.structuredContent.plan.state, "verified");
      assert.equal(writes(f).length, 1);
      assert((await execute(c.client, result.plan)).isError);
      assert.equal(writes(f).length, 1);
    } finally {
      await c.close();
    }
  },
);

for (const action of ["decline", "cancel"])
  test(`native ${action} cancels only the preview and sends no provider request`, async (t) => {
    const f = await hostedFixture(t),
      c = await connect(f, async () => ({ action }));
    try {
      const p = (await plan(c.client)).plan,
        r = await execute(c.client, p);
      assert.equal(r.structuredContent.plan.state, "cancelled");
      assert.equal(writes(f).length, 0);
      assert((await execute(c.client, p)).isError);
    } finally {
      await c.close();
    }
  });

test("model-supplied approvals, mismatched hashes and foreign plans cannot open or satisfy a native prompt", async (t) => {
  const f = await hostedFixture(t);
  let prompts = 0;
  const c = await connect(f, async () => {
    prompts++;
    return { action: "accept", content: {} };
  });
  try {
    const p = (await plan(c.client)).plan;
    for (const args of [
      { plan_id: p.id, plan_hash: p.hash, approved: true },
      { plan_id: p.id, plan_hash: "0".repeat(64) },
    ])
      assert((await tool(c.client, "infomaniak_execute", args)).isError);
    const foreign = { ...p, principal: "another-connection" };
    f.store.put("write-plan", p.id, foreign, Date.now() + 600000);
    assert((await execute(c.client, p)).isError);
    assert.equal(prompts, 0);
    assert.equal(writes(f).length, 0);
  } finally {
    await c.close();
  }
});

for (const change of ["scope", "revocation", "resource", "expiry"])
  test(
    `native approval rechecks ${change} after the user sees the preview`,
    { timeout: 15000 },
    async (t) => {
      const f = await hostedFixture(t, { lifetimeMs: 3600000 });
      let prompts = 0;
      const c = await connect(f, async () => {
        prompts++;
        if (change === "scope")
          f.store.put(
            "grant",
            f.id,
            { ...f.grant, scopes: ["infomaniak:read"], resources: { zones: [], mailboxes: [] } },
            f.grant.expires,
          );
        if (change === "revocation") f.runtime.oauth.disconnect(f.id);
        if (change === "resource")
          f.api.records.push({
            id: 99,
            source: "_native-test",
            type: "TXT",
            target: "changed-outside-the-plan",
            ttl: 300,
          });
        if (change === "expiry") {
          const real = Date.now();
          t.mock.method(Date, "now", () => real + 11 * 60000);
        }
        return { action: "accept", content: {} };
      });
      try {
        const p = (await plan(c.client)).plan;
        const result = await execute(c.client, p).catch(() => null);
        assert.equal(prompts, 1);
        if (change === "resource") assert.equal(result.structuredContent.plan.state, "stale");
        else assert(!result || result.isError);
        assert.equal(writes(f).length, 0);
        assert.notEqual(f.store.get("write-plan", p.id)?.state, "approved");
      } finally {
        await c.close();
      }
    },
  );

for (const capabilities of [{}, { elicitation: { url: {} } }])
  test(`clients without form support retain the independently approved browser path (${JSON.stringify(capabilities)})`, async (t) => {
    const f = await hostedFixture(t),
      c = await connect(f, undefined, capabilities);
    try {
      assert.equal(c.transport.sessionId, undefined);
      const result = await plan(c.client),
        p = result.plan;
      assert.equal(result.approval_method, "browser");
      const rejected = await execute(c.client, p);
      assert.equal(code(rejected), "approval_required");
      assert.equal(writes(f).length, 0);
      const review = await f.request("/write-reviews/" + p.id, {
        headers: { cookie: "ik_manage=" + f.browser },
      });
      assert.match(
        await review.text(),
        /DNS zone: example\.com · Record: _native-test\.example\.com/,
      );
      assert.equal(
        (
          await f.form("/write-reviews/" + p.id, {
            csrf: f.csrf,
            plan_hash: p.hash,
            ack: "APPROVE",
            decision: "approve",
          })
        ).status,
        303,
      );
      assert.equal((await execute(c.client, p)).structuredContent.plan.state, "verified");
    } finally {
      await c.close();
    }
  });

test(
  "prompt responses remain deliverable when all connection tool slots are occupied",
  { timeout: 15000 },
  async (t) => {
    const f = await hostedFixture(t);
    let confirm,
      shown,
      readsReady,
      releaseReads,
      count = 0;
    const prompt = new Promise((r) => (shown = r)),
      blocked = new Promise((r) => (releaseReads = r)),
      allReads = new Promise((r) => (readsReady = r));
    const c = await connect(f, () => {
      shown();
      return new Promise((r) => (confirm = r));
    });
    try {
      const p = (await plan(c.client)).plan;
      const running = execute(c.client, p);
      await prompt;
      const original = f.api.request.bind(f.api);
      f.api.request = async (method, path, ...args) => {
        if (method === "GET" && path.includes("/records")) {
          if (++count === 3) readsReady();
          await blocked;
        }
        return original(method, path, ...args);
      };
      const reads = Array.from({ length: 3 }, () =>
        tool(c.client, "infomaniak_read", {
          operation: "dns.records.list",
          arguments: { account_id: 10, zone: "example.com" },
        }),
      );
      await allReads;
      confirm({ action: "decline" });
      assert.equal((await running).structuredContent.plan.state, "cancelled");
      releaseReads();
      await Promise.all(reads);
      assert.equal(writes(f).length, 0);
    } finally {
      releaseReads();
      await c.close();
    }
  },
);

for (const session of [false, true])
  test(
    `batched tool POSTs retain the per-connection work limit (${session ? "session" : "stateless"})`,
    { timeout: 15000 },
    async (t) => {
      const f = await hostedFixture(t),
        c = session ? await connect(f, async () => ({ action: "decline" })) : undefined;
      let ready,
        release,
        overflow,
        count = 0;
      const full = new Promise((r) => (ready = r)),
        gate = new Promise((r) => (release = r)),
        exceeded = new Promise((r) => (overflow = r)),
        original = f.api.request.bind(f.api);
      f.api.request = async (method, path, ...args) => {
        if (method === "GET" && path.includes("/records")) {
          if (++count === 4) ready();
          if (count > 4) overflow("extra provider read started");
          await gate;
        }
        return original(method, path, ...args);
      };
      const post = (id) =>
        f
          .request("/mcp", {
            method: "POST",
            headers: {
              authorization: "Bearer " + f.access,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              ...(c ? { "mcp-session-id": c.transport.sessionId } : {}),
            },
            body: JSON.stringify([
              {
                jsonrpc: "2.0",
                id,
                method: "tools/call",
                params: {
                  name: "infomaniak_read",
                  arguments: {
                    operation: "dns.records.list",
                    arguments: { account_id: 10, zone: "example.com" },
                  },
                },
              },
            ]),
          })
          .then(async (response) => ({ status: response.status, body: await response.text() }));
      const reads = Array.from({ length: 4 }, (_, id) => post(id + 100));
      let extra;
      try {
        await full;
        extra = post(200);
        assert.equal(await Promise.race([extra.then((r) => r.status), exceeded]), 429);
        assert.equal(count, 4);
      } finally {
        release();
        await Promise.allSettled([...reads, extra]);
        await c?.close();
      }
    },
  );

test("a session belongs to one grant even when another grant has the same account and client", async (t) => {
  const f = await hostedFixture(t),
    c = await connect(f, async () => ({ action: "decline" }));
  try {
    const { randomUUID } = await import("node:crypto"),
      { fingerprint } = await import("../dist/hosted-store.js");
    const id = randomUUID(),
      access = "fixture-other-native-grant";
    f.store.put("grant", id, { ...f.grant, owner: "another-owner" }, f.grant.expires);
    f.store.put(
      "access",
      fingerprint(access),
      { grant: id, client: f.grant.client, expires: Math.floor(f.grant.expires / 1000) },
      f.grant.expires,
    );
    const response = await f.request("/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + access,
        "mcp-session-id": c.transport.sessionId,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "infomaniak_status", arguments: {} },
      }),
    });
    assert.equal(response.status, 404);
    assert.equal((await tool(c.client, "infomaniak_status", {})).structuredContent.account_id, 10);
  } finally {
    await c.close();
  }
});

test("session capacity is bounded, DELETE releases capacity, and idle sessions expire", async (t) => {
  let now = Date.now();
  const f = await hostedFixture(t, { now: () => now, lifetimeMs: 3600000 }),
    clients = [];
  try {
    for (let i = 0; i < 5; i++) clients.push(await connect(f, async () => ({ action: "decline" })));
    await assert.rejects(connect(f, async () => ({ action: "decline" })));
    await clients[0].transport.terminateSession();
    clients.push(await connect(f, async () => ({ action: "decline" })));
    const session = clients.at(-1).transport.sessionId;
    now += 11 * 60000;
    const expired = await f.request("/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + f.access,
        "mcp-session-id": session,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    assert.equal(expired.status, 404);
    assert.equal(writes(f).length, 0);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
  }
});

test("legacy empty elicitation capability negotiates a real native form", async (t) => {
  const f = await hostedFixture(t);
  let prompted = false;
  const c = await connect(
    f,
    async () => {
      prompted = true;
      return { action: "decline" };
    },
    { elicitation: {} },
  );
  try {
    const p = (await plan(c.client)).plan;
    assert.equal((await execute(c.client, p)).structuredContent.plan.state, "cancelled");
    assert(prompted);
    assert.equal(writes(f).length, 0);
  } finally {
    await c.close();
  }
});

test("duplicate prompts and extra connection prompts are refused without consuming a second approval", async (t) => {
  const f = await hostedFixture(t);
  let shown,
    decide,
    prompts = 0;
  const pending = new Promise((r) => (shown = r));
  const c = await connect(f, () => {
    prompts++;
    shown();
    return new Promise((r) => (decide = r));
  });
  try {
    const a = (await plan(c.client, "a")).plan,
      b = (await plan(c.client, "b")).plan;
    const running = execute(c.client, a);
    await pending;
    assert.equal(code(await execute(c.client, a)), "approval_pending");
    assert.equal(code(await execute(c.client, b)), "approval_pending");
    decide({ action: "decline" });
    await running;
    assert.equal(prompts, 1);
    assert.equal(writes(f).length, 0);
  } finally {
    await c.close();
  }
});

test("native confirmation failures do not approve a plan or prevent a later attempt", async (t) => {
  const f = await hostedFixture(t);
  let attempts = 0;
  const c = await connect(f, async () => {
    attempts++;
    throw new Error("fixture UI unavailable");
  });
  try {
    const p = (await plan(c.client)).plan;
    for (let i = 0; i < 2; i++)
      assert.equal(code(await execute(c.client, p)), "confirmation_unavailable");
    assert.equal(attempts, 2);
    assert.equal(f.store.get("write-plan", p.id).state, "planned");
    assert.equal(writes(f).length, 0);
  } finally {
    await c.close();
  }
});

test("an oversized preview falls back to the full browser review instead of truncating the effect", async (t) => {
  const f = await hostedFixture(t);
  let prompts = 0;
  f.api.records = [1, 2].map((id) => ({
    id,
    source: "_native-test",
    type: "TXT",
    target: "existing-value-" + "x".repeat(5000),
    ttl: 300,
  }));
  const c = await connect(f, async () => {
    prompts++;
    return { action: "accept", content: {} };
  });
  try {
    const p = (await plan(c.client)).plan;
    const r = await execute(c.client, p);
    assert.equal(code(r), "approval_required");
    assert.match(r.content[0].text, /write-reviews/);
    assert.equal(prompts, 0);
    assert.equal(writes(f).length, 0);
    assert.equal(f.store.get("write-plan", p.id).state, "planned");
  } finally {
    await c.close();
  }
});

test(
  "acknowledged client cancellation while a prompt is open cannot turn a late acceptance into a write",
  { timeout: 15000 },
  async (t) => {
    const f = await hostedFixture(t);
    let shown, decide;
    const pending = new Promise((r) => (shown = r)),
      controller = new AbortController();
    const c = await connect(f, () => {
      shown();
      return new Promise((r) => (decide = r));
    });
    let delivered;
    const cancelled = new Promise((r) => (delivered = r));
    const originalSend = c.transport.send.bind(c.transport);
    c.transport.send = async (message, options) => {
      await originalSend(message, options);
      if (message.method === "notifications/cancelled") delivered();
    };
    try {
      const p = (await plan(c.client)).plan;
      const running = c.client
        .callTool(
          { name: "infomaniak_execute", arguments: { plan_id: p.id, plan_hash: p.hash } },
          undefined,
          { signal: controller.signal },
        )
        .catch((e) => e);
      await pending;
      controller.abort();
      await running;
      await cancelled;
      decide({ action: "accept", content: {} });
      await tool(c.client, "infomaniak_status", {});
      assert.equal(writes(f).length, 0);
      assert.equal(f.store.get("write-plan", p.id).state, "planned");
    } finally {
      await c.close();
    }
  },
);

test(
  "cancellation after acceptance but during preflight prevents the provider write",
  { timeout: 15000 },
  async (t) => {
    const f = await hostedFixture(t);
    let entered, release, delivered;
    const preflight = new Promise((r) => (entered = r)),
      gate = new Promise((r) => (release = r)),
      cancelled = new Promise((r) => (delivered = r)),
      controller = new AbortController();
    const original = f.api.request.bind(f.api);
    const c = await connect(f, async () => {
      f.api.request = async (method, path, ...args) => {
        if (method === "GET" && path.includes("/records")) {
          entered();
          await gate;
        }
        return original(method, path, ...args);
      };
      return { action: "accept", content: {} };
    });
    const send = c.transport.send.bind(c.transport);
    c.transport.send = async (message, options) => {
      await send(message, options);
      if (message.method === "notifications/cancelled") delivered();
    };
    try {
      const p = (await plan(c.client)).plan;
      const run = c.client
        .callTool(
          { name: "infomaniak_execute", arguments: { plan_id: p.id, plan_hash: p.hash } },
          undefined,
          { signal: controller.signal },
        )
        .catch((e) => e);
      await preflight;
      controller.abort();
      await run;
      await cancelled;
      release();
      await tool(c.client, "infomaniak_status", {});
      assert.equal(writes(f).length, 0);
    } finally {
      release();
      await c.close();
    }
  },
);

for (const resource of ["DNS", "mailbox"])
  test(
    `acknowledged cancellation during the final ${resource} ownership read prevents an unsent write`,
    { timeout: 15000 },
    async (t) => {
      const f = await hostedFixture(t);
      let entered,
        release,
        delivered,
        checks = 0;
      const waiting = new Promise((r) => (entered = r)),
        gate = new Promise((r) => (release = r)),
        cancelled = new Promise((r) => (delivered = r)),
        controller = new AbortController(),
        original = f.api.request.bind(f.api);
      const c = await connect(f, async () => {
        f.api.request = async (method, path, ...args) => {
          const ownershipRead =
            resource === "DNS"
              ? path.includes("service_name=domain")
              : path === "/1/mail_hostings/30/mailboxes/hello";
          if (method === "GET" && ownershipRead && ++checks === 2) {
            entered();
            await gate;
          }
          return original(method, path, ...args);
        };
        return { action: "accept", content: {} };
      });
      const send = c.transport.send.bind(c.transport);
      c.transport.send = async (message, options) => {
        await send(message, options);
        if (message.method === "notifications/cancelled") delivered();
      };
      try {
        const p =
          resource === "DNS"
            ? (await plan(c.client)).plan
            : (
                await tool(c.client, "infomaniak_plan", {
                  operation: "mail.alias.add",
                  arguments: {
                    account_id: 10,
                    mail_hosting_id: 30,
                    mailbox_name: "hello",
                    alias: "native-test",
                  },
                })
              ).structuredContent.plan;
        const run = c.client
          .callTool(
            { name: "infomaniak_execute", arguments: { plan_id: p.id, plan_hash: p.hash } },
            undefined,
            { signal: controller.signal },
          )
          .catch((e) => e);
        await waiting;
        assert.equal(writes(f).length, 0);
        controller.abort();
        await run;
        await cancelled;
        assert.equal(writes(f).length, 0);
        release();
        for (let i = 0; i < 100 && f.store.get("write-plan", p.id).state === "executing"; i++)
          await new Promise((r) => setTimeout(r, 10));
        assert.equal(writes(f).length, 0);
        assert.equal(f.store.get("write-plan", p.id).state, "failed");
      } finally {
        release();
        await c.close();
      }
    },
  );

test("browser approval and concurrent execution cannot bypass an open native confirmation", async (t) => {
  const f = await hostedFixture(t);
  let p, browserStatus, browserBody, second;
  const c = await connect(f, async () => {
    const response = await f.form("/write-reviews/" + p.id, {
      csrf: f.csrf,
      plan_hash: p.hash,
      ack: "APPROVE",
      decision: "approve",
    });
    browserStatus = response.status;
    browserBody = await response.text();
    second = await execute(c.client, p);
    return { action: "decline" };
  });
  try {
    p = (await plan(c.client)).plan;
    const result = await execute(c.client, p);
    assert.equal(browserStatus, 400);
    assert.match(browserBody, /Finish the open confirmation/);
    assert.equal(code(second), "approval_pending");
    assert.equal(result.structuredContent.plan.state, "cancelled");
    assert.equal(writes(f).length, 0);
  } finally {
    await c.close();
  }
});

test("browser cancellation stays available while a native confirmation is open", async (t) => {
  const f = await hostedFixture(t);
  let p;
  const c = await connect(f, async () => {
    const response = await f.form("/write-reviews/" + p.id, {
      csrf: f.csrf,
      plan_hash: p.hash,
      decision: "cancel",
    });
    assert.equal(response.status, 303);
    return { action: "accept", content: {} };
  });
  try {
    p = (await plan(c.client)).plan;
    assert((await execute(c.client, p)).isError);
    assert.equal(f.store.get("write-plan", p.id).state, "cancelled");
    assert.equal(writes(f).length, 0);
  } finally {
    await c.close();
  }
});

test("each tool in a batch must reserve its own work slot", { timeout: 15000 }, async (t) => {
  const f = await hostedFixture(t);
  let ready,
    release,
    reads = 0;
  const full = new Promise((r) => (ready = r)),
    gate = new Promise((r) => (release = r)),
    original = f.api.request.bind(f.api);
  f.api.request = async (method, path, ...args) => {
    if (method === "GET" && path.includes("/records")) {
      if (++reads === 4) ready();
      await gate;
    }
    return original(method, path, ...args);
  };
  const running = f
    .request("/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + f.access,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(
        Array.from({ length: 8 }, (_, id) => ({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "infomaniak_read",
            arguments: {
              operation: "dns.records.list",
              arguments: { account_id: 10, zone: "example.com" },
            },
          },
        })),
      ),
    })
    .then((r) => r.json());
  try {
    await full;
    await f.request("/healthz");
    assert.equal(reads, 4);
    release();
    const results = await running;
    assert.equal(results.length, 8);
    const denied = results.filter((r) => r.result.isError);
    assert.equal(denied.length, 4);
    assert(denied.every((r) => code(r.result) === "rate_limited"));
  } finally {
    release();
    await running;
  }
});

for (const groups of [1, 8])
  test(
    `aborted sessions retain ${groups === 1 ? "per-grant" : "global"} capacity until tool work finishes`,
    { timeout: 15000 },
    async (t) => {
      const f = await hostedFixture(t),
        total = groups * 4;
      let ready,
        release,
        closed,
        overflow,
        reads = 0,
        closedCount = 0;
      const started = new Promise((r) => (ready = r)),
        gate = new Promise((r) => (release = r)),
        allClosed = new Promise((r) => (closed = r)),
        exceeded = new Promise((r) => (overflow = r)),
        original = f.api.request.bind(f.api);
      f.api.request = async (method, path, ...args) => {
        if (method === "GET" && path.includes("/records")) {
          if (++reads === total) ready();
          if (reads > total) overflow("extra provider read started");
          await gate;
        }
        return original(method, path, ...args);
      };
      f.runtime.server.on("request", (req, res) => {
        if (req.headers["x-fixture-disconnect"] === "yes")
          res.once("close", () => {
            if (++closedCount === total) closed();
          });
      });
      const clients = [],
        controllers = [],
        requests = [];
      let fresh, extra;
      const post = (client, access, id, controller) =>
        f
          .request("/mcp", {
            method: "POST",
            signal: controller?.signal,
            headers: {
              authorization: "Bearer " + access,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-session-id": client.transport.sessionId,
              ...(controller ? { "x-fixture-disconnect": "yes" } : {}),
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: {
                name: "infomaniak_read",
                arguments: {
                  operation: "dns.records.list",
                  arguments: { account_id: 10, zone: "example.com" },
                },
              },
            }),
          })
          .then(async (r) => ({ status: r.status, body: await r.text() }));
      try {
        for (let group = 0; group < groups; group++) {
          const access = group ? await otherGrant(f) : f.access;
          const c = await connect(f, undefined, { elicitation: { form: {} } }, access);
          clients.push(c);
          for (let i = 0; i < 4; i++) {
            const controller = new AbortController();
            controllers.push(controller);
            requests.push(post(c, access, 100 + group * 4 + i, controller));
          }
        }
        await started;
        controllers.forEach((c) => c.abort());
        await Promise.allSettled(requests);
        await allClosed;
        const access = groups === 1 ? f.access : await otherGrant(f);
        fresh = await connect(f, undefined, { elicitation: { form: {} } }, access);
        extra = post(fresh, access, 900);
        assert.equal(await Promise.race([extra.then((r) => r.status), exceeded]), 429);
        assert.equal(reads, total);
        release();
        await new Promise(setImmediate);
        assert(!(await tool(fresh.client, "infomaniak_status", {})).isError);
        assert.equal(writes(f).length, 0);
      } finally {
        release();
        controllers.forEach((c) => c.abort());
        await Promise.allSettled([...requests, extra]);
        await Promise.all(clients.map((c) => c.close()));
        await fresh?.close();
        await new Promise(setImmediate);
      }
    },
  );

for (const change of ["domain", "mailbox", "grant"])
  test(`a closed ${change} failure during final ownership verification releases the unsent write lock`, async (t) => {
    const f = await hostedFixture(t);
    let checks = 0;
    const original = f.api.request.bind(f.api);
    const c = await connect(f, async () => {
      f.api.request = async (method, path, ...args) => {
        const ownershipRead =
          change === "mailbox"
            ? path === "/1/mail_hostings/30/mailboxes/hello"
            : path.includes("service_name=domain");
        if (method === "GET" && ownershipRead && ++checks === 2) {
          if (change === "domain") return [];
          if (change === "mailbox")
            return { mailbox_name: "renamed", mailbox: "renamed@example.com" };
          f.store.put(
            "grant",
            f.id,
            { ...f.grant, resources: { ...f.grant.resources, zones: [] } },
            f.grant.expires,
          );
        }
        return original(method, path, ...args);
      };
      return { action: "accept", content: {} };
    });
    try {
      const p =
        change === "mailbox"
          ? (
              await tool(c.client, "infomaniak_plan", {
                operation: "mail.alias.add",
                arguments: {
                  account_id: 10,
                  mail_hosting_id: 30,
                  mailbox_name: "hello",
                  alias: "native-test",
                },
              })
            ).structuredContent.plan
          : (await plan(c.client)).plan;
      const result = await execute(c.client, p);
      assert.equal(result.structuredContent.plan.state, "failed");
      assert.equal(writes(f).length, 0);
      assert.equal(f.store.list("write-lock").length, 0);
    } finally {
      await c.close();
    }
  });

test("a provider error after mutation dispatch stays unknown and locked until readback", async (t) => {
  const f = await hostedFixture(t),
    original = f.api.request.bind(f.api);
  const c = await connect(f, async () => ({ action: "accept", content: {} }));
  f.api.request = async (method, path, ...args) => {
    const result = await original(method, path, ...args);
    if (method !== "GET")
      throw new PluginError("incomplete_response", "Synthetic incomplete mutation response");
    return result;
  };
  try {
    const p = (await plan(c.client)).plan;
    assert.equal((await execute(c.client, p)).structuredContent.plan.state, "unknown");
    assert.equal(f.store.list("write-lock").length, 1);
    assert.equal(writes(f).length, 1);
    const result = await tool(c.client, "infomaniak_operation", { plan_id: p.id, refresh: true });
    assert.equal(result.structuredContent.plan.state, "verified");
    assert.equal(writes(f).length, 1);
  } finally {
    await c.close();
  }
});

async function otherGrant(f, account = 10) {
  const { randomUUID } = await import("node:crypto"),
    { fingerprint } = await import("../dist/hosted-store.js");
  const id = randomUUID(),
    access = "fixture-native-access-" + id;
  f.store.put("grant", id, { ...f.grant, account }, f.grant.expires);
  f.store.put(
    "access",
    fingerprint(access),
    { grant: id, client: f.grant.client, expires: Math.floor(f.grant.expires / 1000) },
    f.grant.expires,
  );
  return access;
}

test("account confirmation limits apply across separate grants without blocking another account reads", async (t) => {
  const f = await hostedFixture(t),
    resolvers = [];
  let ready;
  const shown = new Promise((r) => (ready = r)),
    handler = () =>
      new Promise((r) => {
        resolvers.push(r);
        if (resolvers.length === 2) ready();
      });
  const a = await connect(f, handler),
    b = await connect(f, handler, { elicitation: { form: {} } }, await otherGrant(f)),
    c = await connect(f, handler, { elicitation: { form: {} } }, await otherGrant(f)),
    other = await connect(f, undefined, {}, await otherGrant(f, 20));
  try {
    const plans = await Promise.all([
      plan(a.client, "a"),
      plan(b.client, "b"),
      plan(c.client, "c"),
    ]);
    const running = [execute(a.client, plans[0].plan), execute(b.client, plans[1].plan)];
    await shown;
    assert.equal(code(await execute(c.client, plans[2].plan)), "approval_pending");
    assert.equal(
      (await tool(other.client, "infomaniak_status", {})).structuredContent.account_id,
      20,
    );
    for (const r of resolvers) r({ action: "decline" });
    await Promise.all(running);
    assert.equal(writes(f).length, 0);
  } finally {
    for (const r of resolvers) r({ action: "decline" });
    await Promise.all([a, b, c, other].map((c) => c.close()));
  }
});

test("one account cannot fill the global session pool through multiple grants", async (t) => {
  const f = await hostedFixture(t),
    clients = [];
  try {
    const second = await otherGrant(f),
      third = await otherGrant(f);
    for (let i = 0; i < 5; i++) clients.push(await connect(f, async () => ({ action: "decline" })));
    for (let i = 0; i < 5; i++)
      clients.push(
        await connect(
          f,
          async () => ({ action: "decline" }),
          { elicitation: { form: {} } },
          second,
        ),
      );
    await assert.rejects(
      connect(f, async () => ({ action: "decline" }), { elicitation: { form: {} } }, third),
    );
    clients.push(
      await connect(
        f,
        async () => ({ action: "decline" }),
        { elicitation: { form: {} } },
        await otherGrant(f, 20),
      ),
    );
  } finally {
    await Promise.all(clients.map((c) => c.close()));
  }
});
