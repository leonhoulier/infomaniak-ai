import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostedStore, fingerprint } from "../dist/hosted-store.js";
import { HostedOAuth } from "../dist/hosted-oauth.js";
import { hostedFixture } from "./fixtures/hosted.mjs";
import { DNS_SCOPE, MAIL_SCOPE, DEPLOY_SCOPE } from "../dist/hosted-resources.js";

test("an abandoned native callback does not retain its unused provider credential", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ik-abandoned-consent-"));
  let now = Date.now();
  const store = new HostedStore(directory, randomBytes(32), () => now),
    oauth = new HostedOAuth(store, new URL("https://hosted.example/"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const pending = {
    client: "fixture-client",
    redirect: "https://ai.example/callback",
    challenge: "fixture-challenge",
    scopes: ["infomaniak:read"],
    token: "fixture-provider-token",
    accounts: [{ id: 10, name: "Owner" }],
    csrf: "fixture-csrf",
  };
  store.put("pending", fingerprint("fixture-request"), pending, now + 600000);
  oauth.complete("fixture-request", pending, 10, "fixture-owner");
  assert.equal(store.list("grant").length, 1);
  now += 60001;
  store.prune();
  assert.equal(store.list("grant").length, 0);
  assert.equal(store.list("connection-record").length, 0);
  assert.equal(store.list("code").length, 0);
});

async function consent(f, readOnly = false) {
  const verifier = randomBytes(32).toString("base64url"),
    challenge = createHash("sha256").update(verifier).digest("base64url");
  const client = await (
    await f.json("/register", {
      client_name: "Consent fixture",
      redirect_uris: ["https://ai.example/callback"],
      token_endpoint_auth_method: "none",
      ...(readOnly ? { scope: "infomaniak:read" } : {}),
    })
  ).json();
  const start = await f.request(
    "/authorize?" +
      new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: f.origin.origin + "/mcp",
      }),
  );
  assert.equal(start.status, 303);
  const cookie = start.headers.getSetCookie()[0].split(";")[0],
    path = start.headers.get("location"),
    request = new URL(path, f.origin).searchParams.get("request");
  const form = (path, data) =>
    f.request(path, {
      method: "POST",
      headers: {
        origin: f.origin.origin,
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(data),
    });
  const page = await (await f.request(path, { headers: { cookie } })).text(),
    csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
  const verified = await form("/connect/token", {
    request,
    csrf,
    provider_token: "fixture-consent-provider-token",
  });
  assert.equal(verified.status, 200);
  const html = await verified.text();
  if (!readOnly) {
    assert.match(html, /Resources your AI can manage/);
    assert(!html.includes("This connection is read-only."));
  }
  const accountCsrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  const finish = await form("/connect/finish", {
    request,
    csrf: accountCsrf,
    account: "10",
    decision: "allow",
    ...(readOnly
      ? {}
      : {
          enable_resources: "yes",
          dns_zones: "EXAMPLE.com",
          mailbox_addresses: "hello@example.com",
          deployment_enrollment: "yes",
        }),
  });
  assert.equal(
    finish.status,
    303,
    /<main[^>]*>([\s\S]*?)<footer>/.exec(await finish.clone().text())?.[1]?.slice(0, 600),
  );
  const callback = new URL(finish.headers.get("location"));
  assert.equal(callback.searchParams.get("iss"), f.origin.href);
  const exchanged = await f.request("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      grant_type: "authorization_code",
      code: callback.searchParams.get("code"),
      code_verifier: verifier,
      redirect_uri: client.redirect_uris[0],
      resource: f.origin.origin + "/mcp",
    }),
  });
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  return { client, tokens: await exchanged.json() };
}
test("fresh hosted clients receive only verified named resource grants, with issuer-bound consent", async (t) => {
  const f = await hostedFixture(t),
    { client, tokens } = await consent(f);
  assert.deepEqual(
    new Set(client.scope.split(" ")),
    new Set(["infomaniak:read", DNS_SCOPE, MAIL_SCOPE, DEPLOY_SCOPE]),
  );
  const caps = await (await f.json("/api/v1/capabilities", undefined, tokens.access_token)).json();
  assert.deepEqual(caps.resources.zones, ["example.com"]);
  assert.equal(caps.resources.mailboxes[0].hosting, 30);
  assert.equal(caps.resources.deploymentEnrollment, true);
  assert(caps.available_reads.includes("dns.records.list"));
  assert(caps.available_reads.includes("mail.aliases.list"));
  assert(!Object.hasOwn(caps, "source"));
  const metadata = await (await f.request("/.well-known/oauth-authorization-server")).json();
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  assert(f.api.calls.every((c) => c.method === "GET"));
});
test("explicit read-only registration stays read-only in the resource edition", async (t) => {
  const f = await hostedFixture(t),
    { tokens } = await consent(f, true);
  assert.equal(tokens.scope, "infomaniak:read");
  const caps = await (await f.json("/api/v1/capabilities", undefined, tokens.access_token)).json();
  assert.equal(caps.writes_enabled, false);
  assert.equal(caps.resources, null);
  assert.equal(
    (
      await f.json(
        "/api/v1/plans",
        {
          operation: "dns.record.create",
          arguments: {
            account_id: 10,
            zone: "example.com",
            source: "staging",
            type: "A",
            target: "192.0.2.1",
            ttl: 300,
          },
        },
        tokens.access_token,
      )
    ).status,
    403,
  );
  assert(f.api.calls.every((c) => c.method === "GET"));
});
