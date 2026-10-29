import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { signed } from "../dist/runner-contract.js";
import { hostedFixture } from "./fixtures/hosted.mjs";
import { abandonHostedPlan, HostedWriteJournal } from "../dist/hosted-writes.js";

async function runnerFixture(t, options = {}) {
  const f = await hostedFixture(t, options),
    keys = generateKeyPairSync("ed25519"),
    privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const response = await f.json("/runner-api/register", {
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    apps: [
      {
        name: "canary",
        repository: "https://github.com/example/canary.git",
        hostname: "canary.example.com",
        container_port: 3000,
        health_path: "/",
      },
    ],
  });
  assert.equal(response.status, 201);
  const registration = await response.json(),
    path = new URL(registration.pairing_url).pathname;
  const pair = () => f.form(path, { csrf: f.csrf, connection: f.id });
  const paired = async () =>
    (
      await f.json("/runner-api/pair-status", {
        request: registration.request,
        signature: signed({ request: registration.request }, privateKey),
      })
    ).json();
  let sequence = 0;
  const poll = async (runner, report) => {
    const payload = { runner, sequence: ++sequence, report };
    return f.json("/runner-api/poll", { ...payload, signature: signed(payload, privateKey) });
  };
  const plan = async (runner, revision) => {
    const r = await f.json("/api/v1/plans", {
      operation: "deployment.release",
      arguments: { account_id: 10, runner_id: runner, app: "canary", revision },
    });
    assert.equal(r.status, 201);
    const prepared = await r.json();
    const csrf = f.store.get("browser", f.owner).csrf;
    assert.equal(
      (
        await f.form(prepared.approval_url, {
          csrf,
          plan_hash: prepared.plan.hash,
          decision: "approve",
          ack: "APPROVE",
        })
      ).status,
      303,
    );
    return prepared.plan;
  };
  return { ...f, pair, paired, poll, plan };
}
const report = (revision, healthy) => ({
  version: 1,
  apps: {
    canary: {
      revision,
      previous_revision: null,
      healthy,
      uncertain: false,
      updated_at: Date.now(),
      url: "https://canary.example.com",
    },
  },
  results: [],
});

test("startup scrubs legacy embedded logs for offline runners without changing their expiry or job evidence", async (t) => {
  for (const permanent of [false, true]) {
    let now = Date.now();
    const f = await runnerFixture(t, { now: () => now, lifetimeMs: 30 * 86400000 });
    await f.pair();
    const { runner } = await f.paired(),
      state = report(null, false);
    await f.poll(runner, state);
    const jobId = randomUUID(),
      legacy = {
        id: jobId,
        app: "canary",
        state: "verified",
        code: "logs",
        logs: "fixture-legacy-private-log",
      };
    f.store.put(
      "runner-job",
      jobId,
      {
        job: { id: jobId, runner, app: "canary", action: "logs" },
        state: "finished",
        result: legacy,
      },
      now + 86400000,
    );
    const saved = f.store.get("runner", runner);
    saved.report.results = [legacy];
    f.store.put("runner", runner, saved, permanent ? Number.MAX_SAFE_INTEGER : now + 2 * 86400000);
    await f.restart();
    assert.deepEqual(f.store.get("runner", runner).report.results, []);
    assert.equal(f.store.get("runner-job", jobId).result.logs, "fixture-legacy-private-log");
    await f.restart(() => {
      now += 86400001;
      f.store.prune();
    });
    assert(f.store.get("runner", runner));
    assert.equal(f.store.get("runner-job", jobId), undefined);
    await f.restart(() => {
      now += 86400000;
      f.store.prune();
    });
    if (permanent) {
      assert.deepEqual(f.store.get("runner", runner).report.results, []);
      await f.restart(() => {
        now += 6 * 86400000;
        f.store.prune();
      });
      assert.deepEqual(f.store.get("runner", runner).report.results, []);
    } else assert.equal(f.store.get("runner", runner), undefined);
  }
});

test("sent log requests cannot retain revoked runners, including pre-upgrade nonexpiring rows", async (t) => {
  let now = Date.now();
  const f = await runnerFixture(t, { now: () => now, lifetimeMs: 30 * 86400000 });
  await f.pair();
  const { runner } = await f.paired(),
    state = report(null, false);
  await f.poll(runner, state);
  assert.equal(
    (
      await f.json("/api/v1/reads", {
        operation: "deployment.logs",
        arguments: { account_id: 10, runner_id: runner, app: "canary" },
      })
    ).status,
    200,
  );
  const job = (await (await f.poll(runner, state)).json()).jobs[0].job;
  assert.equal(job.action, "logs");
  assert.equal(
    (await f.form(`/runners/${runner}/revoke`, { csrf: f.store.get("browser", f.owner).csrf }))
      .status,
    303,
  );
  // Emulate an older release that retained both entries indefinitely.
  f.store.put("runner", runner, f.store.get("runner", runner), Number.MAX_SAFE_INTEGER);
  f.store.put("runner-job", job.id, f.store.get("runner-job", job.id), Number.MAX_SAFE_INTEGER);
  await f.restart();
  state.results = [
    {
      id: job.id,
      app: "canary",
      state: "verified",
      code: "logs",
      logs: "fixture-revoked-private-log",
    },
  ];
  assert.equal((await f.poll(runner, state)).status, 400);
  await f.restart(() => {
    now += 8 * 86400000;
    f.store.prune();
  });
  assert.equal(f.store.get("runner", runner), undefined);
  assert.equal(f.store.get("runner-job", job.id), undefined);
});

test("disconnect denies new work but preserves signed completion and explicit recovery for an issued job", async (t) => {
  const f = await runnerFixture(t);
  await f.pair();
  const { runner } = await f.paired(),
    state = report(null, false);
  await f.poll(runner, state);
  const p = await f.plan(runner, "a".repeat(40));
  await f.json(`/api/v1/plans/${p.id}/execute`, { plan_hash: p.hash });
  await f.poll(runner, state);
  f.store.delete("grant", f.id);
  f.store.prune();
  const denied = await f.json("/api/v1/plans", {
    operation: "deployment.release",
    arguments: { account_id: 10, runner_id: runner, app: "canary", revision: "b".repeat(40) },
  });
  assert.equal(denied.status, 401);
  state.apps.canary = { ...state.apps.canary, revision: "a".repeat(40), healthy: true };
  state.results = [{ id: p.id, app: "canary", state: "verified", code: "ok" }];
  const done = await f.poll(runner, state);
  assert.equal(done.status, 200);
  const response = await done.json();
  assert.deepEqual(response.acknowledged, [p.id]);
  assert.deepEqual(response.jobs, []);
  await f.restart(() =>
    abandonHostedPlan(
      f.store,
      p.id,
      "Runner stopped; completed job and current app manually inspected.",
    ),
  );
  assert.equal(f.store.list("write-lock").length, 0);
});

test("revoked runners can finish only issued deployments; delayed completion retains keys and cannot receive new work", async (t) => {
  let now = Date.now();
  const f = await runnerFixture(t, { now: () => now, lifetimeMs: 30 * 86400000 });
  await f.pair();
  const { runner } = await f.paired(),
    state = report(null, false);
  await f.poll(runner, state);
  const p = await f.plan(runner, "a".repeat(40));
  await f.json(`/api/v1/plans/${p.id}/execute`, { plan_hash: p.hash });
  await f.poll(runner, state);
  assert.equal(
    (await f.form(`/runners/${runner}/revoke`, { csrf: f.store.get("browser", f.owner).csrf }))
      .status,
    303,
  );
  assert.equal((await f.poll(runner, state)).status, 400);
  state.apps.canary.uncertain = true;
  state.results = [{ id: p.id, app: "canary", state: "unknown", code: "runner_interrupted" }];
  assert.equal((await f.poll(runner, state)).status, 200);
  await f.restart(() => {
    now += 8 * 86400000;
    f.store.prune();
  });
  assert(f.store.get("runner", runner));
  state.apps.canary = {
    ...state.apps.canary,
    revision: "a".repeat(40),
    healthy: true,
    uncertain: false,
    updated_at: now,
  };
  state.results = [{ id: p.id, app: "canary", state: "verified", code: "ok" }];
  const done = await f.poll(runner, state);
  assert.equal(done.status, 200);
  assert.deepEqual((await done.json()).jobs, []);
  assert.equal(f.store.get("runner", runner).active, false);
  const denied = await f.json("/api/v1/plans", {
    operation: "deployment.release",
    arguments: { account_id: 10, runner_id: runner, app: "canary", revision: "b".repeat(40) },
  });
  assert.equal(denied.status, 403);
  await f.restart(() =>
    abandonHostedPlan(
      f.store,
      p.id,
      "Runner stopped; signed terminal result and app manually inspected.",
    ),
  );
  await f.restart(() => {
    now += 8 * 86400000;
    f.store.prune();
  });
  assert.equal(f.store.get("runner", runner), undefined);
  assert.equal(f.store.get("runner-job", p.id), undefined);
});

test("a crash before enqueue can be recovered offline after restart without wedging the app", async (t) => {
  const f = await runnerFixture(t);
  await f.pair();
  const { runner } = await f.paired(),
    state = report(null, false);
  await f.poll(runner, state);
  const p = await f.plan(runner, "a".repeat(40));
  await f.restart(() => {
    const journal = new HostedWriteJournal(f.store);
    journal.transition(p.id, p.principal, ["approved"], "executing", {}, p.change.resource);
    journal.close();
  });
  assert.equal(f.store.get("write-plan", p.id).state, "unknown");
  assert.equal(f.store.get("runner-job", p.id), undefined);
  await f.restart(() =>
    abandonHostedPlan(f.store, p.id, "Runner stopped; provider inspected; no job was enqueued."),
  );
  assert.equal(f.store.get("write-plan", p.id).state, "stale");
  assert.equal(f.store.list("write-lock").length, 0);
  const recovery = await f.plan(runner, "b".repeat(40));
  assert.equal(
    (await f.json(`/api/v1/plans/${recovery.id}/execute`, { plan_hash: recovery.hash })).status,
    200,
  );
  assert.equal(f.store.get("runner-job", recovery.id).state, "queued");
});

test("signed reconciliation still works after eight days; only resolved job evidence expires", async (t) => {
  let now = Date.now();
  const f = await runnerFixture(t, { now: () => now, lifetimeMs: 30 * 86400000 });
  await f.pair();
  const { runner } = await f.paired(),
    state = report(null, false);
  await f.poll(runner, state);
  const p = await f.plan(runner, "a".repeat(40));
  await f.json(`/api/v1/plans/${p.id}/execute`, { plan_hash: p.hash });
  await f.poll(runner, state);
  state.apps.canary.uncertain = true;
  state.results = [{ id: p.id, app: "canary", state: "unknown", code: "runner_interrupted" }];
  assert.equal((await f.poll(runner, state)).status, 200);
  await f.restart(() => {
    now += 8 * 86400000;
    f.store.prune();
  });
  assert(f.store.get("runner-job", p.id));
  assert.equal(f.store.list("write-lock").length, 1);
  state.apps.canary = {
    ...state.apps.canary,
    revision: "a".repeat(40),
    healthy: true,
    uncertain: false,
    updated_at: now,
  };
  state.results = [{ id: p.id, app: "canary", state: "verified", code: "ok" }];
  const recovered = await f.poll(runner, state);
  assert.equal(recovered.status, 200);
  assert.deepEqual((await recovered.json()).acknowledged, [p.id]);
  assert.equal(
    (await (await f.json(`/api/v1/plans/${p.id}/reconcile`, {})).json()).plan.state,
    "verified",
  );
  assert.equal(f.store.list("write-lock").length, 0);
  await f.restart(() => {
    now += 8 * 86400000;
    f.store.prune();
  });
  assert.equal(f.store.get("runner-job", p.id), undefined);
  // A lost acknowledgement may be retried after resolved history has expired.
  state.apps.canary.healthy = false;
  state.apps.canary.updated_at = now;
  state.results = [
    {
      id: p.id,
      app: "canary",
      state: "verified",
      code: "logs",
      logs: "fixture-expired-private-log",
    },
  ];
  const late = await f.poll(runner, state);
  assert.equal(late.status, 200);
  const ignored = await late.json();
  assert.deepEqual(ignored.discarded, [p.id]);
  assert.deepEqual(ignored.acknowledged, [p.id]);
  assert.equal(f.store.get("runner", runner).report.apps.canary.healthy, false);
  assert.deepEqual(f.store.get("runner", runner).report.results, []);
  assert(!JSON.stringify(f.store.get("runner", runner)).includes("fixture-expired-private-log"));
  assert.equal(f.store.get("runner-job", p.id), undefined);
});

test("abandonment expires terminal job evidence even when current app state is uncertain", async (t) => {
  let now = Date.now();
  const f = await runnerFixture(t, { now: () => now, lifetimeMs: 30 * 86400000 });
  await f.pair();
  const { runner } = await f.paired(),
    state = report(null, false);
  await f.poll(runner, state);
  const p = await f.plan(runner, "a".repeat(40));
  await f.json(`/api/v1/plans/${p.id}/execute`, { plan_hash: p.hash });
  await f.poll(runner, state);
  state.apps.canary.uncertain = true;
  state.results = [{ id: p.id, app: "canary", state: "failed", code: "build_failed" }];
  assert.equal((await f.poll(runner, state)).status, 200);
  assert(f.store.get("runner-job", p.id).result);
  assert.deepEqual(f.store.get("runner", runner).report.results, []);
  await f.restart(() =>
    abandonHostedPlan(
      f.store,
      p.id,
      "Runner stopped and app manually inspected; terminal job is complete.",
    ),
  );
  assert.equal(f.store.get("write-plan", p.id).state, "stale");
  await f.restart(() => {
    now += 8 * 86400000;
    f.store.prune();
  });
  assert.equal(f.store.get("write-plan", p.id), undefined);
  assert.equal(f.store.get("runner-job", p.id), undefined);
});

test("an explicitly abandoned deployment cannot be delivered after the gateway restarts", async (t) => {
  const f = await runnerFixture(t);
  await f.pair();
  const { runner } = await f.paired(),
    state = report(null, false);
  await f.poll(runner, state);
  const p = await f.plan(runner, "a".repeat(40));
  await f.json(`/api/v1/plans/${p.id}/execute`, { plan_hash: p.hash });
  assert.equal(f.store.get("runner-job", p.id).state, "queued");
  await f.restart(() => {
    // Crash after enqueue but before the engine's pending transition.
    const interrupted = f.store.get("write-plan", p.id);
    interrupted.state = "executing";
    f.store.put("write-plan", p.id, interrupted, Number.MAX_SAFE_INTEGER);
    abandonHostedPlan(f.store, p.id, "Runner stopped; app inspected; job has not run.");
    assert.equal(f.store.get("runner-job", p.id).state, "finished");
  });
  const r = await f.poll(runner, state);
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).jobs, []);
  assert.equal(f.store.get("write-plan", p.id).state, "stale");
  assert.equal(f.store.list("write-lock").length, 0);
  assert.equal(f.store.get("runner-job", p.id).state, "finished");
});

test("operator recovery cannot release the lock of an already delivered job without a terminal result", async (t) => {
  const f = await runnerFixture(t);
  await f.pair();
  const { runner } = await f.paired(),
    state = report(null, false);
  await f.poll(runner, state);
  const p = await f.plan(runner, "a".repeat(40));
  await f.json(`/api/v1/plans/${p.id}/execute`, { plan_hash: p.hash });
  assert.equal((await (await f.poll(runner, state)).json()).jobs[0].job.id, p.id);
  assert.equal(f.store.get("runner-job", p.id).state, "sent");
  await f.restart(() =>
    assert.throws(
      () => abandonHostedPlan(f.store, p.id, "Gateway stopped; app inspected manually."),
      { code: "runner_job_in_flight" },
    ),
  );
  assert.equal(f.store.get("write-plan", p.id).state, "pending");
  assert.equal(f.store.list("write-lock").length, 1);
});

test("a healthy same-commit app cannot verify a queued deployment before its exact runner job completes", async (t) => {
  const f = await runnerFixture(t);
  assert.equal((await f.pair()).status, 303);
  const { runner } = await f.paired(),
    state = report("a".repeat(40), true);
  assert.equal((await f.poll(runner, state)).status, 200);
  const p = await f.plan(runner, state.apps.canary.revision);
  const execute = await f.json(`/api/v1/plans/${p.id}/execute`, { plan_hash: p.hash });
  assert.equal(execute.status, 200);
  assert.equal((await execute.json()).plan.state, "pending");
  assert.equal(f.store.get("runner-job", p.id).state, "queued");
  const readback = await f.json(`/api/v1/plans/${p.id}/reconcile`, {});
  assert.equal((await readback.json()).plan.state, "pending");
  assert.equal(f.store.list("write-lock").length, 1);
  const delivered = await (await f.poll(runner, state)).json();
  assert.equal(delivered.jobs[0].job.id, p.id);
  state.results = [{ id: p.id, app: "canary", state: "verified", code: "ok" }];
  assert.equal((await f.poll(runner, state)).status, 200);
  assert.equal(
    (await (await f.json(`/api/v1/plans/${p.id}/reconcile`, {})).json()).plan.state,
    "verified",
  );
  assert.equal(f.store.list("write-lock").length, 0);
});

test("historical job success is acknowledged despite current unhealthy state and cannot block recovery polling", async (t) => {
  const f = await runnerFixture(t);
  assert.equal((await f.pair()).status, 303);
  const { runner } = await f.paired(),
    state = report(null, false);
  await f.poll(runner, state);
  const p = await f.plan(runner, "a".repeat(40));
  assert.equal((await f.json(`/api/v1/plans/${p.id}/execute`, { plan_hash: p.hash })).status, 200);
  await f.poll(runner, state);
  state.apps.canary.revision = "a".repeat(40);
  state.results = [{ id: p.id, app: "canary", state: "verified", code: "ok" }];
  for (let i = 0; i < 3; i++) {
    const r = await f.poll(runner, state);
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).acknowledged, [p.id]);
  }
  assert.equal(f.store.get("runner", runner).report.apps.canary.healthy, false);
  assert.equal(f.store.get("write-plan", p.id).state, "failed");
  assert.equal(f.store.list("write-lock").length, 0);
  const recovery = await f.plan(runner, "b".repeat(40));
  await f.json(`/api/v1/plans/${recovery.id}/execute`, { plan_hash: recovery.hash });
  state.results = [];
  assert.equal((await (await f.poll(runner, state)).json()).jobs[0].job.id, recovery.id);
});

test("pairing rechecks revocation and consumption inside the atomic save", async (t) => {
  const f = await runnerFixture(t),
    atomic = f.store.atomic.bind(f.store);
  let intercepted = false;
  f.store.atomic = (fn) => {
    if (!intercepted) {
      intercepted = true;
      f.store.delete("grant", f.id);
    }
    return atomic(fn);
  };
  assert.equal((await f.pair()).status, 400);
  assert.equal(f.store.get("grant", f.id), undefined);
  assert.equal(f.store.list("runner").length, 0);
  assert(intercepted);
});
