import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, chmod, symlink, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../dist/application.js";
import { AccessSchema, digest } from "../dist/access.js";
import { Journal } from "../dist/journal.js";
import { loadCatalogue } from "../dist/catalogue.js";
import { canonical, fingerprint } from "../dist/registry.js";
import {
  fixture,
  policy,
  createArgs,
  mailbox,
  CLIENT_KEY,
  HUMAN_KEY,
  PROVIDER_KEY,
  FixtureApi,
} from "./fixtures/api.mjs";

test("plan fingerprints are independent of locale and object insertion order", (t) => {
  t.mock.method(String.prototype, "localeCompare", () => {
    throw new Error("Plan hashing must not use locale-dependent collation");
  });
  const first = { z: ["z", "A"], A: { ä: 3, _: 4 }, ä: 5, _: 6 };
  const second = { _: 6, ä: 5, A: { _: 4, ä: 3 }, z: ["z", "A"] };
  assert.equal(canonical(first), '{"A":{"_":4,"ä":3},"_":6,"z":["z","A"],"ä":5}');
  assert.equal(fingerprint(first), fingerprint(second));
  assert.notEqual(fingerprint(first), fingerprint({ ...second, z: ["A", "z"] }));
});

test("full public catalogue is discoverable; metadata cannot authorize execution", async (t) => {
  const f = await fixture(t);
  const catalogue = await loadCatalogue();
  assert.equal(catalogue.operations.length, 1514);
  assert.equal(new Set(catalogue.operations.map((r) => r.product)).size, 15);
  const search = await f.call("infomaniak_search", { query: "delete", limit: 5 });
  assert(search.operations.some((o) => !o.implemented));
  const entry = catalogue.operations.find((r) => r.product === "VOD" && r.method === "DELETE");
  await assert.rejects(f.engine.plan(entry.id, {}), { code: "operation_denied" });
  assert.equal(f.api.calls.length, 0);
  let count = 0,
    offset = 0;
  do {
    const page = await f.call("infomaniak_catalogue", { offset, limit: 20 });
    count += page.operations.length;
    offset = page.next_offset;
  } while (offset !== null);
  assert.equal(count, 1514);
});
test("plans do not mutate, self-approval is unavailable, independent approval binds exact effects", async (t) => {
  const f = await fixture(t),
    p = await f.engine.plan("dns.record.create", createArgs);
  assert.equal(p.state, "planned");
  assert.equal(f.api.calls.filter((r) => r.method !== "GET").length, 0);
  await assert.rejects(f.engine.execute(p.id, p.hash), { code: "approval_required" });
  await assert.rejects(f.call("infomaniak_approve", { plan_id: p.id }), { code: "unknown_tool" });
  await assert.rejects(
    f.call("infomaniak_execute", { plan_id: p.id, plan_hash: p.hash, approved: true }),
  );
  assert.throws(() => f.app.approve(f.principal, p.id, "0".repeat(64)), { code: "plan_mismatch" });
  f.app.approve(f.principal, p.id, p.hash);
  const result = await f.engine.execute(p.id, p.hash);
  assert.equal(result.state, "verified");
  assert.equal(f.api.calls.filter((r) => r.method === "POST").length, 1);
  await assert.rejects(f.engine.execute(p.id, p.hash));
  assert.equal(f.api.calls.filter((r) => r.method === "POST").length, 1);
});
test("cross-account/resource access, malformed paths and unsupported DNS changes fail before API calls", async (t) => {
  const f = await fixture(t);
  for (const args of [
    { ...createArgs, account_id: 20 },
    { ...createArgs, zone: "other.example" },
    { ...createArgs, zone: "../example.com" },
    { ...createArgs, target: "not-ip" },
    { ...createArgs, type: "PTR" }, // Readable record type, absent from the pinned creation schema.
  ])
    await assert.rejects(f.engine.plan("dns.record.create", args));
  await assert.rejects(
    f.engine.plan("dns.record.update", {
      account_id: 10,
      zone: "example.com",
      record_id: 1,
      source: "changed",
    }),
  );
  await assert.rejects(
    f.engine.plan("mail.alias.add", { ...mailbox, mailbox_name: "../hello", alias: "new" }),
  );
  await assert.rejects(f.engine.read("mail.mailbox.get", { ...mailbox, mail_hosting_id: 99 }));
  await assert.rejects(
    f.engine.plan("mail.alias.add", { ...mailbox, mailbox_name: "production", alias: "new" }),
  );
  assert.equal(f.api.calls.length, 0);
});
test("all reviewed DNS and mailbox writes perform a single mutation and verify exact resulting state", async (t) => {
  const f = await fixture(t);
  const scenarios = [
    [
      "dns.record.update",
      { account_id: 10, zone: "example.com", record_id: 1, target: "192.0.2.2", ttl: 600 },
    ],
    ["dns.record.delete", { account_id: 10, zone: "example.com", record_id: 1 }],
    ["mail.alias.add", { ...mailbox, alias: "new" }],
    ["mail.alias.delete", { ...mailbox, alias: "new" }],
    ["mail.forwarding.add", { ...mailbox, redirect_address: "new@example.net" }],
    ["mail.forwarding.delete", { ...mailbox, redirect_address: "new@example.net" }],
    ["mail.forwarding.update", { ...mailbox, is_enabled: false }],
  ];
  for (const [name, args] of scenarios) {
    const p = await f.engine.plan(name, args);
    if (name === "mail.forwarding.update") assert.deepEqual(p.change.after.redirect_addresses, []);
    f.app.approve(f.principal, p.id, p.hash);
    assert.equal((await f.engine.execute(p.id, p.hash)).state, "verified", name);
  }
  assert.equal(f.api.calls.filter((r) => r.method !== "GET").length, scenarios.length);
});
test("a stale approved plan sends no mutation and cannot be replayed", async (t) => {
  const f = await fixture(t),
    p = await f.engine.plan("dns.record.create", createArgs);
  f.app.approve(f.principal, p.id, p.hash);
  f.api.records.push({ id: 2, source: "new", type: "TXT", target: "concurrent", ttl: 300 });
  assert.equal((await f.engine.execute(p.id, p.hash)).state, "stale");
  assert.equal(f.api.calls.filter((r) => r.method !== "GET").length, 0);
});
test("expiry and cancelled approvals cannot execute", async (t) => {
  const f = await fixture(t),
    p = await f.engine.plan("dns.record.create", createArgs);
  assert.throws(() => f.app.journal.approve(p.id, f.principal.id, p.hash, p.expires_at + 1), {
    code: "plan_expired",
  });
  f.app.approve(f.principal, p.id, p.hash);
  t.mock.method(Date, "now", () => p.expires_at + 1);
  await assert.rejects(f.engine.execute(p.id, p.hash), { code: "plan_expired" });
  t.mock.restoreAll();
  f.engine.cancel(p.id);
  await assert.rejects(f.engine.execute(p.id, p.hash));
  assert.equal(f.api.calls.filter((r) => r.method !== "GET").length, 0);
});
test("uncertain writes remain locked and reconcile without repeating a mutation", async (t) => {
  const f = await fixture(t),
    p = await f.engine.plan("dns.record.create", createArgs);
  f.app.approve(f.principal, p.id, p.hash);
  f.api.failure = "uncertain";
  assert.equal((await f.engine.execute(p.id, p.hash)).state, "unknown");
  const q = await f.engine.plan("dns.record.create", { ...createArgs, source: "other" });
  f.app.approve(f.principal, q.id, q.hash);
  await assert.rejects(f.engine.execute(q.id, q.hash), { code: "resource_busy" });
  f.api.failure = undefined;
  assert.equal((await f.engine.reconcile(p.id)).state, "verified");
  assert.equal(f.api.calls.filter((r) => r.method === "POST").length, 1);
});
test("provider rejection is recorded; failed readback remains pending and never retries writes", async (t) => {
  const f = await fixture(t),
    p = await f.engine.plan("dns.record.create", createArgs);
  f.app.approve(f.principal, p.id, p.hash);
  f.api.failure = "rejected";
  assert.equal((await f.engine.execute(p.id, p.hash)).state, "failed");
  f.api.failure = "readback";
  const q = await f.engine.plan("dns.record.create", createArgs);
  f.app.approve(f.principal, q.id, q.hash);
  assert.equal((await f.engine.execute(q.id, q.hash)).state, "pending");
  const count = f.api.calls.filter((r) => r.method !== "GET").length;
  assert.equal((await f.engine.reconcile(q.id)).state, "pending");
  f.api.readFailure = false;
  assert.equal((await f.engine.reconcile(q.id)).state, "verified");
  assert.equal(f.api.calls.filter((r) => r.method !== "GET").length, count);
});
test("resource locks serialize concurrent approved plans", async (t) => {
  const f = await fixture(t),
    p = await f.engine.plan("dns.record.create", createArgs),
    q = await f.engine.plan("dns.record.create", { ...createArgs, source: "other" });
  f.app.approve(f.principal, p.id, p.hash);
  f.app.approve(f.principal, q.id, q.hash);
  let release;
  f.api.gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = f.engine.execute(p.id, p.hash);
  await assert.rejects(f.engine.execute(q.id, q.hash), { code: "resource_busy" });
  release();
  assert.equal((await first).state, "verified");
  assert.equal(f.api.calls.filter((r) => r.method === "POST").length, 1);
});
test("plans persist, process-crash states recover to unknown and another runtime is rejected", async (t) => {
  const f = await fixture(t),
    p = await f.engine.plan("dns.record.create", createArgs);
  f.app.approve(f.principal, p.id, p.hash);
  await assert.rejects(
    Application.create(f.config, { FIXTURE_PROVIDER: PROVIDER_KEY }, () => f.api),
    { code: "state_in_use" },
  );
  f.app.journal.transition(p.id, f.principal.id, ["approved"], "executing", {}, p.change.resource);
  await f.close();
  const next = await Application.create(f.config, { FIXTURE_PROVIDER: PROVIDER_KEY }, () => f.api);
  t.after(() => next.close());
  assert.equal(next.journal.get(p.id, f.principal.id).state, "unknown");
  assert.equal(f.api.calls.filter((r) => r.method !== "GET").length, 0);
  assert.equal((await next.engines.get(f.principal.id).reconcile(p.id)).state, "unknown");
});
test("tenant operation state and account inventory are isolated", async (t) => {
  const f = await fixture(t),
    p = await f.engine.plan("dns.record.create", createArgs);
  assert.throws(() => f.app.journal.get(p.id, "other"), { code: "plan_not_found" });
  const accounts = await f.engine.read("accounts.list", { account_id: 10 });
  assert.deepEqual(accounts.data, [{ id: 10, name: "Owner" }]);
  const products = await f.engine.read("products.list", { account_id: 10 });
  assert.deepEqual(products.data, [
    {
      id: 30,
      account_id: 10,
      service_id: 3,
      service_name: "email_hosting",
      customer_name: "example.com",
    },
  ]);
  assert(f.api.calls.some((c) => c.path === "/1/products?account_id=10&per_page=1000"));
  const mailboxes = await f.engine.read("mail.mailboxes.list", {
    account_id: 10,
    mail_hosting_id: 30,
  });
  assert.deepEqual(mailboxes.data, [
    {
      mailbox_name: "hello",
      email: "hello@example.com",
      type: null,
      is_free_mail: false,
      is_limited: false,
    },
  ]);
  assert(!JSON.stringify(mailboxes).includes("private@example.net"));
});
test("disabled writes, disposable-only grants and duplicate credentials fail closed", async (t) => {
  const f = await fixture(t);
  f.principal.writes = "disabled";
  await assert.rejects(f.engine.plan("dns.record.create", createArgs), { code: "writes_disabled" });
  f.principal.writes = "disposable-only";
  f.principal.resources.zones["example.com"].disposable = false;
  await assert.rejects(f.engine.plan("dns.record.create", createArgs), { code: "writes_disabled" });
  const broken = structuredClone(f.config);
  broken.principals[0].approval_token_sha256 = digest(CLIENT_KEY);
  assert.throws(() => AccessSchema.parse(broken));
  await assert.rejects(
    Application.create(f.config, { FIXTURE_PROVIDER: CLIENT_KEY }, () => new FixtureApi()),
    { code: "invalid_configuration" },
  );
});
test("unsafe state permissions and symlinked databases are rejected", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ik-state-security-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await chmod(dir, 0o755);
  assert.throws(() => new Journal(dir), { code: "unsafe_state_directory" });
  await chmod(dir, 0o700);
  await symlink(join(dir, "target"), join(dir, "operations.sqlite"));
  assert.throws(() => new Journal(dir), { code: "unsafe_state_directory" });
});
test("journal contains no provider credential and events survive reopening", async (t) => {
  const f = await fixture(t),
    p = await f.engine.plan("mail.alias.add", { ...mailbox, alias: "new" });
  f.app.approve(f.principal, p.id, p.hash);
  await f.engine.execute(p.id, p.hash);
  await f.close();
  const raw = await readFile(join(f.config.state_directory, "operations.sqlite"));
  assert(!raw.includes(PROVIDER_KEY));
  assert(!raw.includes(HUMAN_KEY));
  const db = new Journal(f.config.state_directory);
  t.after(() => db.close());
  assert.equal(db.get(p.id, f.principal.id).state, "verified");
});

test("a named DNS write grant cannot alter another name or expose unrelated records in its preview", async (t) => {
  const f = await fixture(t);
  f.principal.resources.zones["example.com"].writable = false;
  f.principal.resources.zones["example.com"].disposable = false;
  f.principal.resources.dns_names["example.com:new"] = {
    account_id: 10,
    disposable: true,
    writable: true,
  };
  const p = await f.engine.plan("dns.record.create", createArgs);
  assert.deepEqual(p.change.before, []);
  await assert.rejects(f.engine.plan("dns.record.create", { ...createArgs, source: "www" }), {
    code: "access_denied",
  });
  await assert.rejects(
    f.engine.plan("dns.record.delete", {
      account_id: 10,
      zone: "example.com",
      record_id: 1,
      expected_source: "new",
    }),
    { code: "resource_not_found" },
  );
  await assert.rejects(
    f.engine.plan("dns.record.delete", { account_id: 10, zone: "example.com", record_id: 1 }),
    { code: "writes_disabled" },
  );
  f.app.approve(f.principal, p.id, p.hash);
  assert.equal((await f.engine.execute(p.id, p.hash)).state, "verified");
  const q = await f.engine.plan("dns.record.delete", {
    account_id: 10,
    zone: "example.com",
    record_id: 2,
    expected_source: "new",
  });
  f.app.approve(f.principal, q.id, q.hash);
  assert.equal((await f.engine.execute(q.id, q.hash)).state, "verified");
  assert.equal(f.api.records.length, 1);
  assert.equal(f.api.records[0].source, "www");
});
test("known secrets in arguments or observed state are rejected before persistence", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.engine.plan("dns.record.create", { ...createArgs, type: "TXT", target: PROVIDER_KEY }),
    { code: "secret_input_denied" },
  );
  f.api.records.push({ id: 2, source: "new", type: "TXT", target: PROVIDER_KEY, ttl: 300 });
  await assert.rejects(
    f.engine.plan("dns.record.create", { ...createArgs, type: "TXT", target: "public" }),
    { code: "secret_input_denied" },
  );
  assert.equal(f.app.journal.list(f.principal.id).length, 0);
});
test("a plan expiring during preflight sends no mutation", async (t) => {
  const f = await fixture(t),
    p = await f.engine.plan("dns.record.create", createArgs);
  f.app.approve(f.principal, p.id, p.hash);
  const request = f.api.request.bind(f.api);
  f.api.request = async (...args) => {
    const data = await request(...args);
    t.mock.method(Date, "now", () => p.expires_at + 1);
    return data;
  };
  assert.equal((await f.engine.execute(p.id, p.hash)).state, "failed");
  assert.equal(f.api.calls.filter((r) => r.method !== "GET").length, 0);
});
