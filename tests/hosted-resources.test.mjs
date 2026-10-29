import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { HostedStore } from "../dist/hosted-store.js";
import { HostedWrites } from "../dist/hosted-writes.js";
import { DNS_SCOPE, MAIL_SCOPE, verifyResources } from "../dist/hosted-resources.js";
import { FixtureApi } from "./fixtures/api.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "ik-resources-")),
    store = new HostedStore(dir, randomBytes(32)),
    api = new FixtureApi();
  api.domains = [{ id: 11, account_id: 10, service_name: "domain", customer_name: "example.com" }];
  const transport = {
    request: async (method, path, body) => {
      if (method === "GET" && path === "/1/products?account_id=10&per_page=1000")
        return [
          ...api.domains,
          { id: 30, account_id: 10, service_name: "email_hosting", customer_name: "example.com" },
        ];
      return api.request(method, path, body);
    },
  };
  const writes = new HostedWrites(store, () => transport),
    id = randomUUID(),
    grant = {
      activated: true,
      account: 10,
      owner: "fixture-owner",
      client: "fixture-client",
      token: "fixture-resource-provider-token",
      scopes: ["infomaniak:read", DNS_SCOPE, MAIL_SCOPE],
      resources: {
        zones: ["example.com"],
        mailboxes: [{ hosting: 30, name: "hello", address: "hello@example.com" }],
      },
      created: Date.now(),
      expires: Date.now() + 600000,
    };
  store.put("grant", id, grant, grant.expires);
  t.after(async () => {
    writes.journal.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { store, api, transport, writes, id, grant };
}
test("hosted resource consent resolves names and refuses foreign or absent domains and mailboxes", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await verifyResources(f.transport, 10, ["EXAMPLE.com"], ["hello@example.com"]),
    f.grant.resources,
  );
  await assert.rejects(verifyResources(f.transport, 10, ["foreign.example"], []), {
    code: "resource_not_found",
  });
  await assert.rejects(verifyResources(f.transport, 10, [], ["missing@example.com"]), {
    code: "resource_not_found",
  });
  assert(f.api.calls.every((c) => c.method === "GET"));
});
test("hosted full DNS writes preserve other records, require approval, verify and prepare independent recovery", async (t) => {
  const f = await fixture(t),
    before = structuredClone(f.api.records);
  const { plan } = await f.writes.dispatch(f.id, f.grant, "infomaniak_plan", {
    operation: "dns.record.create",
    arguments: {
      account_id: 10,
      zone: "example.com",
      source: "staging",
      type: "A",
      target: "192.0.2.7",
      ttl: 300,
    },
  });
  await assert.rejects(
    f.writes.dispatch(f.id, f.grant, "infomaniak_execute", {
      plan_id: plan.id,
      plan_hash: plan.hash,
    }),
    { code: "approval_required" },
  );
  f.writes.journal.approve(plan.id, f.id, plan.hash);
  const result = await f.writes.dispatch(f.id, f.grant, "infomaniak_execute", {
    plan_id: plan.id,
    plan_hash: plan.hash,
  });
  assert.equal(result.plan.state, "verified");
  assert.deepEqual(f.api.records[0], before[0]);
  const recovery = await f.writes.recovery(f.id, f.grant, result.plan);
  assert.equal(recovery.operation, "dns.record.delete");
  assert.equal(recovery.state, "planned");
  f.writes.journal.approve(recovery.id, f.id, recovery.hash);
  assert.equal(
    (
      await f.writes.dispatch(f.id, f.grant, "infomaniak_execute", {
        plan_id: recovery.id,
        plan_hash: recovery.hash,
      })
    ).plan.state,
    "verified",
  );
  assert.deepEqual(f.api.records, before);
});
test("hosted aliases and forwarding use the consented mailbox and reject another account or mailbox", async (t) => {
  const f = await fixture(t),
    args = { account_id: 10, mail_hosting_id: 30, mailbox_name: "hello", alias: "test" };
  const { plan } = await f.writes.dispatch(f.id, f.grant, "infomaniak_plan", {
    operation: "mail.alias.add",
    arguments: args,
  });
  f.writes.journal.approve(plan.id, f.id, plan.hash);
  assert.equal(
    (
      await f.writes.dispatch(f.id, f.grant, "infomaniak_execute", {
        plan_id: plan.id,
        plan_hash: plan.hash,
      })
    ).plan.state,
    "verified",
  );
  assert(f.api.aliases.aliases.includes("test"));
  for (const change of [{ account_id: 20 }, { mail_hosting_id: 31 }, { mailbox_name: "other" }])
    await assert.rejects(
      f.writes.dispatch(f.id, f.grant, "infomaniak_plan", {
        operation: "mail.alias.add",
        arguments: { ...args, ...change },
      }),
    );
  const forwarding = await f.writes.dispatch(f.id, f.grant, "infomaniak_plan", {
    operation: "mail.forwarding.add",
    arguments: {
      account_id: 10,
      mail_hosting_id: 30,
      mailbox_name: "hello",
      redirect_address: "recipient@example.net",
    },
  });
  assert.match(JSON.stringify(forwarding.plan.change), /recipient@example.net/);
  assert.equal(forwarding.plan.state, "planned");
});
test("resource removal or moved hosting blocks an already approved write before mutation", async (t) => {
  const f = await fixture(t),
    { plan } = await f.writes.dispatch(f.id, f.grant, "infomaniak_plan", {
      operation: "dns.record.create",
      arguments: {
        account_id: 10,
        zone: "example.com",
        source: "staging",
        type: "TXT",
        target: "fixture",
        ttl: 300,
      },
    });
  f.writes.journal.approve(plan.id, f.id, plan.hash);
  const narrowed = structuredClone(f.grant);
  narrowed.resources.zones = [];
  f.store.put("grant", f.id, narrowed, narrowed.expires);
  const result = await f.writes.dispatch(f.id, f.grant, "infomaniak_execute", {
    plan_id: plan.id,
    plan_hash: plan.hash,
  });
  assert.equal(result.plan.state, "failed");
  assert(f.api.calls.every((c) => c.method === "GET"));
});
test("DNS verification tolerates host presentation changes, but rejects wrong data and wrong-family updates", async (t) => {
  const f = await fixture(t),
    underlying = f.transport.request;
  f.transport.request = async (method, path, body) => {
    const result = await underlying(method, path, body);
    if (method === "POST" && body?.type === "CNAME")
      f.api.records.at(-1).target = body.target.toLowerCase() + ".";
    return result;
  };
  const { plan } = await f.writes.dispatch(f.id, f.grant, "infomaniak_plan", {
    operation: "dns.record.create",
    arguments: {
      account_id: 10,
      zone: "example.com",
      source: "staging",
      type: "CNAME",
      target: "Target.EXAMPLE.net",
      ttl: 300,
    },
  });
  f.writes.journal.approve(plan.id, f.id, plan.hash);
  const result = await f.writes.dispatch(f.id, f.grant, "infomaniak_execute", {
    plan_id: plan.id,
    plan_hash: plan.hash,
  });
  assert.equal(result.plan.state, "verified");
  assert.equal(
    (await f.writes.recovery(f.id, f.grant, result.plan)).operation,
    "dns.record.delete",
  );
  await assert.rejects(
    f.writes.dispatch(f.id, f.grant, "infomaniak_plan", {
      operation: "dns.record.update",
      arguments: {
        account_id: 10,
        zone: "example.com",
        record_id: 1,
        expected_source: "www",
        target: "2001:db8::1",
      },
    }),
    { code: "invalid_input" },
  );
  const writes = f.api.calls.filter((c) => c.method !== "GET");
  assert.equal(writes.length, 1);
});
