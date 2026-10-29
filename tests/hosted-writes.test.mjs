import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { HostedStore } from "../dist/hosted-store.js";
import { HostedWriteJournal, abandonHostedPlan } from "../dist/hosted-writes.js";
const plan = () => ({
  id: randomUUID(),
  principal: "owner",
  operation: "dns.record.create",
  revision: "fixture",
  args: {},
  change: {
    before: [],
    after: [],
    request: { method: "POST", path: "/fixture" },
    impact: "test",
    recovery: "test",
    resource: "dns:example.com",
  },
  hash: "a".repeat(64),
  state: "planned",
  created_at: Date.now(),
  updated_at: Date.now(),
  expires_at: Date.now() + 600000,
});
test("expired unsent plans are bounded history while pending writes remain retained", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ik-expired-capacity-"));
  let now = Date.now();
  const store = new HostedStore(dir, randomBytes(32), () => now);
  let journal = new HostedWriteJournal(store);
  t.after(async () => {
    journal.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (let batch = 0; batch < 11; batch++) {
    for (let i = 0; i < 20; i++) {
      const p = journal.create({ ...plan(), args: { account_id: 10 }, expires_at: now + 1000 });
      if (i % 2 === 0) journal.approve(p.id, p.principal, p.hash);
    }
    journal.close();
    now += 2000;
    journal = new HostedWriteJournal(store);
  }
  assert(store.list("write-plan").length <= 200);
  const p = journal.create({ ...plan(), args: { account_id: 10 }, expires_at: now + 1000 });
  journal.approve(p.id, p.principal, p.hash);
  journal.transition(p.id, p.principal, ["approved"], "executing", {}, p.change.resource);
  journal.transition(p.id, p.principal, ["executing"], "unknown");
  journal.close();
  now += 8 * 86400000;
  journal = new HostedWriteJournal(store);
  store.prune();
  assert.equal(store.get("write-plan", p.id).state, "unknown");
  assert.equal(store.list("write-lock").length, 1);
});
test("completed history cannot exhaust another customer's active-plan capacity, and recovery is explicit and offline", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ik-write-capacity-")),
    store = new HostedStore(dir, randomBytes(32));
  let journal = new HostedWriteJournal(store);
  t.after(async () => {
    journal.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 205; i++) {
    const p = journal.create({ ...plan(), args: { account_id: 10 } });
    journal.transition(p.id, p.principal, ["planned"], "cancelled");
  }
  assert(store.list("write-plan").length <= 200);
  const other = journal.create({ ...plan(), principal: "other", args: { account_id: 20 } });
  journal.approve(other.id, other.principal, other.hash);
  journal.transition(
    other.id,
    other.principal,
    ["approved"],
    "executing",
    {},
    other.change.resource,
  );
  journal.transition(other.id, other.principal, ["executing"], "unknown");
  assert.throws(
    () => abandonHostedPlan(store, other.id, "Provider inspected; no delayed job remains."),
    { code: "state_in_use" },
  );
  journal.close();
  abandonHostedPlan(store, other.id, "Provider inspected; no delayed job remains.");
  const retained = store.get("write-plan", other.id);
  assert.equal(retained.state, "stale");
  assert.match(retained.outcome, /UNVERIFIED/);
  journal = new HostedWriteJournal(store);
  const next = journal.create({ ...plan(), principal: "new-connection", args: { account_id: 20 } });
  journal.approve(next.id, next.principal, next.hash);
  journal.transition(next.id, next.principal, ["approved"], "executing", {}, next.change.resource);
});
test("encrypted hosted journal rejects a second writer, preserves uncertain locks across restart and cannot unlock another plan through cancellation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ik-write-journal-"));
  const store = new HostedStore(dir, randomBytes(32));
  let journal = new HostedWriteJournal(store);
  t.after(async () => {
    journal.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.throws(() => new HostedWriteJournal(store), /owns this vault/);
  const a = journal.create(plan()),
    b = journal.create(plan()),
    c = journal.create(plan());
  journal.approve(a.id, "owner", a.hash);
  journal.transition(a.id, "owner", ["approved"], "executing", {}, a.change.resource);
  journal.transition(b.id, "owner", ["planned"], "cancelled");
  journal.approve(c.id, "owner", c.hash);
  assert.throws(
    () => journal.transition(c.id, "owner", ["approved"], "executing", {}, c.change.resource),
    /unreconciled write/,
  );
  journal.close();
  journal = new HostedWriteJournal(store);
  assert.equal(journal.get(a.id, "owner").state, "unknown");
  assert.throws(
    () => journal.transition(c.id, "owner", ["approved"], "executing", {}, c.change.resource),
    /unreconciled write/,
  );
  journal.transition(a.id, "owner", ["unknown"], "verified");
  journal.transition(c.id, "owner", ["approved"], "executing", {}, c.change.resource);
  assert.throws(() => journal.get(c.id, "other"), /belongs to this connection/);
  store.put("write-runtime", "lease", { id: "another-runtime" }, store.now() + 30000);
  assert.throws(() => journal.get(c.id, "owner"), /lost its lease/);
});
