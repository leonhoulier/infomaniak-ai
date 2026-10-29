import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { HostedStore } from "../dist/hosted-store.js";
import { HostedOAuth } from "../dist/hosted-oauth.js";
import { hostedFixture } from "./fixtures/hosted.mjs";
import { fixture, createArgs } from "./fixtures/api.mjs";
import { fingerprint } from "../dist/registry.js";

test("parallel client consent pages survive another tab starting and finishing sign-in", async (t) => {
  const f = await hostedFixture(t),
    verifier = "v".repeat(50),
    challenge = createHash("sha256").update(verifier).digest("base64url");
  const client = await (
    await f.json("/register", {
      client_name: "Parallel tabs",
      redirect_uris: ["https://ai.example/callback"],
      token_endpoint_auth_method: "none",
      scope: "infomaniak:read",
    })
  ).json();
  const begin = async (cookie) => {
    const r = await f.request(
      "/authorize?" +
        new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: client.redirect_uris[0],
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
      { headers: cookie ? { cookie } : {} },
    );
    assert.equal(r.status, 303);
    return { cookie: r.headers.getSetCookie()[0].split(";")[0], path: r.headers.get("location") };
  };
  const a = await begin(),
    b = await begin(a.cookie);
  assert.equal(a.cookie, b.cookie);
  const verify = async (flow) => {
    const html = await (await f.request(flow.path, { headers: { cookie: flow.cookie } })).text(),
      csrf = /name="csrf" value="([^"]+)"/.exec(html)[1],
      request = new URL(flow.path, f.origin).searchParams.get("request");
    const r = await f.request("/connect/token", {
      method: "POST",
      headers: {
        origin: f.origin.origin,
        cookie: flow.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        csrf,
        request,
        provider_token: "fixture-parallel-provider-token",
      }),
    });
    assert.equal(r.status, 200);
    const verified = await r.text();
    return { request, csrf: /name="csrf" value="([^"]+)"/.exec(verified)[1] };
  };
  const preparedA = await verify(a);
  await verify(b);
  const finish = await f.request("/connect/finish", {
    method: "POST",
    headers: {
      origin: f.origin.origin,
      cookie: a.cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ ...preparedA, account: "10", decision: "allow" }),
  });
  assert.equal(finish.status, 303);
  assert(
    !finish.headers
      .getSetCookie()
      .some((c) => c.startsWith("ik_connect=") && c.includes("Expires=Thu, 01 Jan 1970")),
  );
  assert.equal((await f.request(b.path, { headers: { cookie: b.cookie } })).status, 200);
  assert.equal(
    (await f.request(b.path, { headers: { cookie: "ik_connect=" + "x".repeat(43) } })).status,
    400,
  );
});

test("known pre-Zod-4 plans can reconcile through reads but cannot execute, and unknown contracts stay refused", async (t) => {
  const f = await fixture(t),
    p = await f.engine.plan("dns.record.create", createArgs);
  const legacy = JSON.parse(
    await readFile(new URL("../data/legacy-operation-revisions.json", import.meta.url), "utf8"),
  );
  p.revision = legacy.operations[p.operation].revision;
  const { id, principal, operation, revision, args, change, expires_at } = p;
  p.hash = fingerprint({ id, principal, operation, revision, args, change, expires_at });
  const fakeJournal = {
    get: () => p,
    create: () => assert.fail(),
    transition: (_id, _principal, _from, state, patch) => Object.assign(p, { state, ...patch }),
  };
  const { Engine } = await import("../dist/engine.js");
  const engine = new Engine(fakeJournal, f.principal, f.api, []);
  await assert.rejects(engine.execute(p.id, p.hash), { code: "plan_mismatch" });
  p.state = "unknown";
  f.api.records = structuredClone(p.change.after).map((record, index) => ({
    id: index + 1,
    ...record,
  }));
  const result = await engine.reconcile(p.id);
  assert.equal(result.state, "verified");
  assert(f.api.calls.every((c) => c.method === "GET"));
  p.state = "unknown";
  p.revision = "1:" + "f".repeat(64);
  p.hash = fingerprint({
    id,
    principal,
    operation,
    revision: p.revision,
    args,
    change,
    expires_at,
  });
  await assert.rejects(engine.reconcile(p.id), { code: "plan_mismatch" });
});

test("unclaimed OAuth registrations expire, active grants retain their clients, and mixed callback lists use only supported URLs", async (t) => {
  const d = await mkdtemp(join(tmpdir(), "ik-client-retention-"));
  let now = Date.now();
  const store = new HostedStore(d, randomBytes(32), () => now),
    oauth = new HostedOAuth(store, new URL("https://hosted.example"));
  t.after(async () => {
    store.close();
    await rm(d, { recursive: true, force: true });
  });
  const input = {
    redirect_uris: [
      "cursor://anysphere.cursor-mcp/oauth/callback",
      "https://www.cursor.com/agents/mcp/oauth/callback",
      "http://localhost:8787/callback",
    ],
    token_endpoint_auth_method: "none",
  };
  const unused = await oauth.clientsStore.registerClient(input),
    active = await oauth.clientsStore.registerClient(input);
  assert.deepEqual(active.redirect_uris, input.redirect_uris.slice(1));
  await assert.rejects(async () =>
    oauth.clientsStore.registerClient({ ...input, redirect_uris: [input.redirect_uris[0]] }),
  );
  store.put(
    "grant",
    "fixture-grant",
    { client: active.client_id, activated: true, expires: now + 3 * 86400000 },
    now + 3 * 86400000,
  );
  await oauth.clientsStore.getClient(active.client_id);
  now += 86400001;
  store.prune();
  assert.equal(await oauth.clientsStore.getClient(unused.client_id), undefined);
  assert(await oauth.clientsStore.getClient(active.client_id));
});

test("trusted-proxy OAuth limits isolate real clients; forwarding headers cannot bypass limits by default", async (t) => {
  for (const trustProxyHops of [0, 1]) {
    const f = await hostedFixture(t, { trustProxyHops });
    const register = (ip) =>
      f.request("/register", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({
          client_name: "Proxy fixture",
          redirect_uris: ["https://ai.example/callback"],
          token_endpoint_auth_method: "none",
        }),
      });
    for (let i = 0; i < 20; i++) assert.equal((await register("192.0.2.1")).status, 201);
    assert.equal((await register("192.0.2.1")).status, 429);
    assert.equal((await register("192.0.2.2")).status, trustProxyHops === 1 ? 201 : 429);
  }
});

test("revocation between permission lookup and atomic save cannot resurrect a grant", async (t) => {
  const f = await hostedFixture(t),
    atomic = f.store.atomic.bind(f.store);
  let intercepted = false;
  f.store.atomic = (fn) => {
    if (!intercepted) {
      intercepted = true;
      f.store.delete("grant", f.id);
    }
    return atomic(fn);
  };
  const r = await f.form("/connections/" + f.id + "/access", {
    csrf: f.csrf,
    zones: "example.com",
    enrollment: "yes",
  });
  assert.equal(r.status, 400);
  assert.equal(f.store.get("grant", f.id), undefined);
  assert(intercepted);
});
