import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, randomUUID, randomBytes } from "node:crypto";
import { signed, validSignature, Report } from "../dist/runner-contract.js";
import { hostedFixture } from "./fixtures/hosted.mjs";
import { fingerprint } from "../dist/hosted-store.js";

test("pairing, signed pulls and exact approval bind deployments to one account, runner, app and pinned revision", async (t) => {
  const f = await hostedFixture(t),
    pair = generateKeyPairSync("ed25519"),
    privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const definition = {
    name: "canary",
    repository: "https://github.com/example/canary.git",
    hostname: "canary.example.com",
    container_port: 3000,
    health_path: "/",
  };
  const registration = await f.json("/runner-api/register", { publicKey, apps: [definition] });
  assert.equal(registration.status, 201);
  const registered = await registration.json();
  const pairPath = new URL(registered.pairing_url).pathname;
  assert.equal(
    (await f.form(pairPath, { csrf: f.csrf, connection: f.id }, "foreign-browser")).status,
    400,
  );
  assert.equal((await f.form(pairPath, { csrf: f.csrf, connection: f.id })).status, 303);
  const paired = await (
    await f.json("/runner-api/pair-status", {
      request: registered.request,
      signature: signed({ request: registered.request }, privateKey),
    })
  ).json();
  assert(paired.runner && paired.publicKey);
  let sequence = 0;
  const poll = async (report, override = {}) => {
    const payload = {
      runner: paired.runner,
      sequence: ++sequence,
      report: Report.parse(report),
      ...override,
    };
    return f.json("/runner-api/poll", { ...payload, signature: signed(payload, privateKey) });
  };
  const initial = {
    version: 1,
    apps: {
      canary: {
        revision: null,
        previous_revision: null,
        healthy: false,
        uncertain: false,
        updated_at: Date.now(),
        url: "https://canary.example.com",
      },
    },
    results: [],
  };
  assert.equal((await poll(initial)).status, 200);
  assert.equal((await poll(initial, { sequence: 1 })).status, 400);
  sequence = 1;
  const planned = await f.json("/api/v1/plans", {
    operation: "deployment.release",
    arguments: {
      account_id: 10,
      runner_id: paired.runner,
      app: "canary",
      revision: "a".repeat(40),
    },
  });
  assert.equal(planned.status, 201);
  const { plan, approval_url } = await planned.json();
  assert.equal(plan.change.before.definition.repository, definition.repository);
  const unapproved = await f.json("/api/v1/plans/" + plan.id + "/execute", {
    plan_hash: plan.hash,
  });
  assert.equal(unapproved.status, 409, await unapproved.text());
  const review = await f.request(approval_url, { headers: { cookie: "ik_manage=" + f.browser } });
  assert.equal(review.status, 200);
  assert.match(await review.text(), /github.com\/example\/canary.git/);
  assert.equal(
    (
      await f.form(approval_url, {
        csrf: f.csrf,
        plan_hash: plan.hash,
        decision: "approve",
        ack: "APPROVE",
      })
    ).status,
    303,
  );
  const execution = await f.json("/api/v1/plans/" + plan.id + "/execute", { plan_hash: plan.hash });
  assert.equal(execution.status, 200);
  assert.equal((await execution.json()).plan.state, "pending");
  const response = await (await poll(initial)).json();
  assert.equal(response.jobs.length, 1);
  const envelope = response.jobs[0];
  assert(validSignature(envelope.job, envelope.signature, paired.publicKey));
  assert.equal(envelope.job.id, plan.id);
  assert.equal(envelope.job.revision, "a".repeat(40));
  assert(
    !validSignature({ ...envelope.job, app: "foreign" }, envelope.signature, paired.publicKey),
  );
  const done = structuredClone(initial);
  done.apps.canary.revision = "a".repeat(40);
  done.apps.canary.healthy = true;
  done.results = [{ id: plan.id, app: "canary", state: "verified", code: "ok" }];
  assert.equal((await poll(done)).status, 200);
  const reconciled = await f.json("/api/v1/plans/" + plan.id + "/reconcile", {});
  assert.equal((await reconciled.json()).plan.state, "verified");
  assert.equal(
    (await f.json("/api/v1/plans/" + plan.id + "/execute", { plan_hash: plan.hash })).status,
    409,
  );
  const secondGrant = {
      ...f.grant,
      owner: "different-owner",
      resources: { ...f.grant.resources, deployments: [{ runner: paired.runner, app: "canary" }] },
    },
    secondId = randomUUID();
  f.store.put("grant", secondId, secondGrant, secondGrant.expires);
  f.store.put(
    "access",
    fingerprint("other-fixture-access"),
    {
      grant: secondId,
      client: secondGrant.client,
      expires: Math.floor(secondGrant.expires / 1000),
    },
    secondGrant.expires,
  );
  assert.equal(
    (
      await f.json(
        "/api/v1/plans",
        {
          operation: "deployment.release",
          arguments: {
            account_id: 10,
            runner_id: paired.runner,
            app: "canary",
            revision: "b".repeat(40),
          },
        },
        "other-fixture-access",
      )
    ).status,
    403,
  );
  assert(f.api.calls.every((c) => c.method === "GET"));
});

test("operations history and permission removal remain browser-owned and cannot elevate resources", async (t) => {
  const f = await hostedFixture(t),
    prepared = await (
      await f.json("/api/v1/plans", {
        operation: "dns.record.create",
        arguments: {
          account_id: 10,
          zone: "example.com",
          source: "staging",
          type: "A",
          target: "192.0.2.7",
          ttl: 300,
        },
      })
    ).json();
  const own = await f.request("/operations", { headers: { cookie: "ik_manage=" + f.browser } });
  assert.equal(own.status, 200);
  assert((await own.text()).includes(prepared.plan.id));
  const otherBrowser = randomBytes(32).toString("base64url");
  f.store.put("browser", fingerprint(otherBrowser), { csrf: "other-csrf" }, f.grant.expires);
  const other = await f.request("/operations", {
    headers: { cookie: "ik_manage=" + otherBrowser },
  });
  assert.equal(other.status, 200);
  assert(!(await other.text()).includes(prepared.plan.id));
  assert.equal(
    (
      await f.request("/operations/" + prepared.plan.id, {
        headers: { cookie: "ik_manage=" + otherBrowser },
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.form("/connections/" + f.id + "/access", { csrf: f.csrf, zones: "foreign.example" }))
      .status,
    400,
  );
  assert(f.store.get("grant", f.id).resources.zones.includes("example.com"));
  assert.equal((await f.form("/connections/" + f.id + "/access", { csrf: f.csrf })).status, 303);
  assert.equal(
    (
      await f.json("/api/v1/plans", {
        operation: "dns.record.create",
        arguments: {
          account_id: 10,
          zone: "example.com",
          source: "staging",
          type: "A",
          target: "192.0.2.9",
          ttl: 300,
        },
      })
    ).status,
    403,
  );
  assert(f.api.calls.every((c) => c.method === "GET"));
});
