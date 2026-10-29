import assert from "node:assert/strict";
import { test } from "node:test";
import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { startPreview, DEMO_TOKEN } from "../scripts/preview-hosted.mjs";

const field = (html, name) => {
  const match = new RegExp('name="' + name + '" value="([^"]+)"').exec(html);
  assert(match, "Missing form field " + name);
  return match[1];
};
async function begin(preview) {
  const start = await fetch(new URL("/start", preview.testOrigin), { redirect: "manual" }),
    authorize = await fetch(start.headers.get("location"), { redirect: "manual" }),
    cookie = authorize.headers.getSetCookie()[0].split(";")[0],
    location = new URL(authorize.headers.get("location"), preview.origin),
    html = await (await fetch(location, { headers: { cookie } })).text();
  return { cookie, html, request: location.searchParams.get("request") };
}
const form = (preview, path, data, cookie) =>
  fetch(new URL(path, preview.origin), {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: preview.origin.origin,
      cookie,
    },
    body: new URLSearchParams(data),
  });

test("private demo completes browser consent, actual MCP reads, disconnect and temporary vault cleanup", async (t) => {
  const p = await startPreview({ port: 0 });
  t.after(p.close);
  const home = await (await fetch(p.testOrigin)).text();
  assert(home.includes("No Infomaniak request is made"));
  assert(home.includes(DEMO_TOKEN));
  const flow = await begin(p);
  assert(flow.html.includes("Real tokens are refused"));
  const verified = await form(
    p,
    "/connect/token",
    {
      request: flow.request,
      csrf: field(flow.html, "csrf"),
      provider_token: DEMO_TOKEN,
    },
    flow.cookie,
  );
  assert.equal(verified.status, 200);
  const accounts = await verified.text();
  const finish = await form(
    p,
    "/connect/finish",
    {
      request: flow.request,
      csrf: field(accounts, "csrf"),
      account: "10",
      decision: "allow",
    },
    flow.cookie,
  );
  assert.equal(finish.status, 303);
  const result = await fetch(finish.headers.get("location"), { redirect: "manual" }),
    html = await result.text();
  assert.equal(result.status, 200);
  assert(html.includes("Your connection works"));
  assert(html.includes("6 tools"));
  assert(html.includes("Writes are disabled"));
  assert(html.includes("example.test"));
  assert(html.includes("Demo VPS Cloud"));
  assert(!html.includes("Demo team"));
  assert(!html.includes(DEMO_TOKEN));
  const cookie = finish.headers
      .getSetCookie()
      .find((c) => c.startsWith("ik_manage="))
      .split(";")[0],
    management = await (
      await fetch(new URL("/connections", p.origin), { headers: { cookie } })
    ).text();
  assert.equal(
    (
      await form(
        p,
        "/connections/revoke",
        {
          connection: field(management, "connection"),
          csrf: field(management, "csrf"),
        },
        cookie,
      )
    ).status,
    303,
  );
  const disconnected = await (
    await fetch(new URL("/connections", p.origin), { headers: { cookie } })
  ).text();
  assert(disconnected.includes("No active connections"));
  const directory = p.directory;
  await p.close();
  await assert.rejects(stat(directory), { code: "ENOENT" });
  await assert.rejects(fetch(p.testOrigin));
});

test("demo rejects other tokens without persisting them and the test driver refuses POSTs", async (t) => {
  const p = await startPreview({ port: 0 });
  t.after(p.close);
  const unknown = "fixture-this-must-never-reach-infomaniak",
    flow = await begin(p),
    rejected = await form(
      p,
      "/connect/token",
      {
        request: flow.request,
        csrf: field(flow.html, "csrf"),
        provider_token: unknown,
      },
      flow.cookie,
    );
  assert.equal(rejected.status, 400);
  assert(!(await rejected.text()).includes(unknown));
  assert.equal((await fetch(new URL("/start", p.testOrigin), { method: "POST" })).status, 403);
  assert(!(await readFile(join(p.directory, "hosted.sqlite"))).includes(Buffer.from(unknown)));
});

test("account preview requires explicit live mode and offers private entry without automatic provider reads", async (t) => {
  const p = await startPreview({ port: 0, live: true });
  t.after(p.close);
  const home = await (await fetch(p.testOrigin)).text(),
    flow = await begin(p);
  assert(home.includes("Use your own Infomaniak account"));
  assert(!home.includes(DEMO_TOKEN));
  assert(flow.html.includes("Private account test"));
  assert(flow.html.includes('type="password"'));
  assert(!flow.html.includes('name="account"'));
});
