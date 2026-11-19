import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "parse5";
import { hostedFixture } from "./fixtures/hosted.mjs";
import { FIRST_PROMPT, claudeCommand } from "../dist/hosted-pages.js";
import { GUIDE_PATHS } from "../dist/hosted-guides.js";

function elements(html) {
  const nodes = [];
  function walk(node) {
    if (node.tagName) nodes.push(node);
    for (const child of node.childNodes ?? []) walk(child);
  }
  walk(parse(html));
  return nodes;
}
const attr = (node, key) => node?.attrs?.find((a) => a.name === key)?.value;
const text = (node) => (node?.value ?? "") + (node?.childNodes ?? []).map(text).join("");

test("English/French task guides are crawlable, reciprocal, canonical and linked in the sitemap", async (t) => {
  const f = await hostedFixture(t);
  const sitemap = await (await f.request("/sitemap.xml")).text();
  const llms = await (await f.request("/llms.txt")).text();
  assert(llms.includes(f.origin.origin + "/guides"));
  assert(llms.includes(f.origin.origin + "/fr/guides"));
  const titles = new Set();
  for (const path of GUIDE_PATHS) {
    const response = await f.request(path),
      html = await response.text(),
      nodes = elements(html),
      lang = path.startsWith("/fr/") ? "fr" : "en",
      en = path.replace(/^\/fr\//, "/"),
      alternates = nodes.filter((n) => n.tagName === "link" && attr(n, "rel") === "alternate");
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("x-robots-tag"), /index, follow/);
    assert.equal(
      attr(
        nodes.find((n) => n.tagName === "html"),
        "lang",
      ),
      lang,
    );
    const title = text(nodes.find((n) => n.tagName === "title"));
    assert(title.length > 15 && !titles.has(title), path);
    titles.add(title);
    assert.equal(nodes.filter((n) => n.tagName === "h1").length, 1);
    assert(
      attr(
        nodes.find((n) => n.tagName === "meta" && attr(n, "name") === "description"),
        "content",
      ).length > 60,
    );
    assert.equal(
      attr(
        nodes.find((n) => n.tagName === "link" && attr(n, "rel") === "canonical"),
        "href",
      ),
      f.origin.origin + path,
    );
    assert.deepEqual(
      Object.fromEntries(alternates.map((n) => [attr(n, "hreflang"), attr(n, "href")])),
      {
        en: f.origin.origin + en,
        fr: f.origin.origin + "/fr" + en,
        "x-default": f.origin.origin + en,
      },
    );
    assert(sitemap.includes("<loc>" + f.origin.origin + path + "</loc>"));
    assert(
      nodes.some((n) => n.tagName === "a" && attr(n, "href") === (lang === "fr" ? en : "/fr" + en)),
    );
    if (path.endsWith("claude-code")) {
      assert(
        text(nodes.find((n) => attr(n, "id") === "guide-first-prompt")).includes(
          FIRST_PROMPT[lang],
        ),
      );
      assert.equal(
        text(nodes.find((n) => attr(n, "id") === "guide-claude-command")),
        claudeCommand(f.origin.origin + "/mcp"),
      );
      assert(html.includes("https://code.claude.com/docs/en/mcp"));
    }
  }
});

test("the resource homepage leads with the same read-only audit and keeps client choices and writes visible", async (t) => {
  const f = await hostedFixture(t);
  const html = await (await f.request("/")).text(),
    nodes = elements(html);
  assert.match(text(nodes.find((n) => n.tagName === "h1")), /Infomaniak DNS/);
  assert.equal(text(nodes.find((n) => attr(n, "id") === "first-prompt")), FIRST_PROMPT.en);
  assert.equal(
    text(nodes.find((n) => attr(n, "id") === "claude-command")),
    claudeCommand(f.origin.origin + "/mcp"),
  );
  for (const href of [
    "/guides/claude-code",
    "/guides/dns-records",
    "/guides/vps-deploy",
    "/fr/guides",
    "/clients/codex",
    "/clients/cursor",
    "/clients/vscode",
    "/plugins",
  ])
    assert(
      nodes.some((n) => n.tagName === "a" && attr(n, "href") === href),
      href,
    );
  assert.match(html, /each write needs your confirmation/i);
  assert(!/guaranteed|in 30 seconds|trusted by \d/i.test(html));
});

test("discovery-only mode does not advertise resource task pages in its sitemap or first prompt", async (t) => {
  const f = await hostedFixture(t, { resourceWrites: false });
  assert.equal((await f.request("/guides/claude-code")).status, 404);
  assert(!(await (await f.request("/sitemap.xml")).text()).includes("/guides"));
  assert(!(await (await f.request("/")).text()).includes(FIRST_PROMPT.en));
});

test("guide request counts respect GPC and DNT and use fixed language/task labels", async (t) => {
  const events = [];
  const f = await hostedFixture(t, {
    analytics: { record: (...args) => events.push(args), shutdown: async () => {} },
  });
  await f.request("/guides/dns-records", { headers: { "sec-gpc": "1" } });
  await f.request("/fr/guides/dns-records", { headers: { dnt: "1" } });
  assert.deepEqual(events, []);
  await f.request("/fr/guides/dns-records");
  assert.deepEqual(events, [["guide_viewed", undefined, { guide: "dns-records", lang: "fr" }]]);
});
