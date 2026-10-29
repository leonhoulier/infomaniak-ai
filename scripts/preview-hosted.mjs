import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHosted, PREVIEW_DEMO_TOKEN } from "../dist/hosted.js";
import { HostedStore } from "../dist/hosted-store.js";
import { page, escapeHtml as e } from "../dist/hosted-pages.js";

export const DEMO_TOKEN = PREVIEW_DEMO_TOKEN;
const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
const stop = async (server) => {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
};

/** Private test driver, never a public deployment or an AI platform connection. */
export async function startPreview({ port = 8789, live = false } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65534 || (port !== 0 && port < 1024))
    throw new Error("Use a port from 1024 to 65534.");
  const callbackPortRequested = port === 0 ? 0 : port + 1;
  if (port === 0) {
    const reservation = createServer();
    port = await listen(reservation, 0);
    await stop(reservation);
  }
  const directory = await mkdtemp(join(tmpdir(), "infomaniak-ai-preview-")),
    key = randomBytes(32),
    store = new HostedStore(directory, key),
    origin = new URL("http://127.0.0.1:" + port),
    flows = new Map();
  const demoApi = (token) => ({
    request: async (method, path) => {
      if (token !== DEMO_TOKEN || method !== "GET") throw new Error("Demo access refused.");
      if (path === "/1/accounts")
        return [
          { id: 10, name: "My demo account" },
          { id: 20, name: "Demo team" },
        ];
      const id = Number(new URL(path, "https://api.infomaniak.com").searchParams.get("account_id"));
      if (path.startsWith("/1/products?") && [10, 20].includes(id))
        return [
          { id: 101, account_id: id, service_name: "domain", customer_name: "example.test" },
          {
            id: 102,
            account_id: id,
            service_name: "mail",
            customer_name: "Mail Service · example.test",
          },
          { id: 103, account_id: id, service_name: "vps", customer_name: "Demo VPS Cloud" },
        ];
      throw new Error("Demo route refused.");
    },
  });
  const { server, oauth } = createHosted({
    origin,
    store,
    allowLoopback: true,
    previewMode: live ? "live" : "demo",
    ...(live ? {} : { api: demoApi }),
  });
  const notice = live
    ? "Private account test · Read-only Infomaniak requests. Your temporary connection is deleted when you stop the test."
    : "Private demo · Example data only. No Infomaniak request is made; real tokens are refused.";
  let callbackOrigin, client, closing;
  const browser = createServer((req, res) => {
    void (async () => {
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      if (req.headers.host !== callbackOrigin.host || req.method !== "GET") {
        res.statusCode = 403;
        res.end("Preview request refused.");
        return;
      }
      const url = new URL(req.url, callbackOrigin);
      const show = (title, body) => {
        res.setHeader("content-type", "text/html; charset=utf-8");
        // Keep all preview navigation on the real gateway, including disconnect.
        res.end(
          page(title, body, notice)
            .replaceAll('href="/"', 'href="' + origin.href + '"')
            .replaceAll('href="/privacy"', 'href="' + new URL("/privacy", origin).href + '"')
            .replaceAll(
              'href="/connections"',
              'href="' + new URL("/connections", origin).href + '"',
            )
            .replaceAll(
              'href="/.well-known/oauth-authorization-server"',
              'href="' + new URL("/.well-known/oauth-authorization-server", origin).href + '"',
            )
            .replaceAll('href="/healthz"', 'href="' + new URL("/healthz", origin).href + '"'),
        );
      };
      if (url.pathname === "/") {
        show(
          "Try your connection",
          `<div class="eyebrow">Private test · ${live ? "Your account" : "Demo data"}</div><h1>Try the whole connection.</h1><p class="lead">Walk through the same consent and read-only MCP requests used by the shared service, without publishing it.</p><section class="panel"><h2>${live ? "Use your own Infomaniak account" : "Start with example services"}</h2><ol><li>Open the private connection page below.</li><li>${live ? "Enter your own API token in its password field. This makes GET-only requests to Infomaniak, using only the account you approve." : "Enter this demo token in its password field:"}</li></ol>${live ? "" : `<code>${DEMO_TOKEN}</code>`}<ol start="3"><li>Choose an account and allow read-only discovery.</li><li>See the account and products returned by a real MCP SDK client.</li><li>Use Manage connection to disconnect, then stop this terminal with Ctrl+C.</li></ol><a class="button" href="/start">${live ? "Test my account" : "Try demo connection"} →</a><a class="button secondary" href="${origin.href}">Preview the homepage</a><p class="notice">${live ? "The test uses a temporary encrypted vault on this computer. Its key stays in memory. No token is read from your environment, printed or sent to an AI platform." : "Demo mode accepts only the example token above. Do not enter a real token. Use the explicit --live option for an account test."}</p><small>This browser test stands in for an AI client. ChatGPT, Claude and Grok still need a reachable HTTPS deployment for their native connection flows.</small></section>`,
        );
        return;
      }
      if (url.pathname === "/start") {
        for (const [id, flow] of flows) if (flow.expires < Date.now()) flows.delete(id);
        if (flows.size >= 20) throw new Error("Too many preview flows.");
        const state = randomBytes(32).toString("base64url"),
          verifier = randomBytes(48).toString("base64url");
        flows.set(state, { verifier, expires: Date.now() + 600_000 });
        const params = new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: client.redirect_uris[0],
          response_type: "code",
          code_challenge_method: "S256",
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          resource: oauth.resource.href,
          scope: "infomaniak:read",
          state,
        });
        res.writeHead(303, { location: new URL("/authorize?" + params, origin).href });
        res.end();
        return;
      }
      if (url.pathname !== "/callback") {
        res.statusCode = 404;
        res.end("Not found.");
        return;
      }
      const state = url.searchParams.get("state"),
        flow = flows.get(state);
      flows.delete(state);
      if (!flow || flow.expires <= Date.now()) throw new Error("Preview flow expired.");
      if (url.searchParams.has("error")) {
        show(
          "Connection cancelled",
          '<h1>Nothing was connected.</h1><p><a href="/start">Try again</a></p>',
        );
        return;
      }
      const response = await fetch(new URL("/token", origin), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          code: url.searchParams.get("code") ?? "",
          code_verifier: flow.verifier,
          redirect_uri: client.redirect_uris[0],
          resource: oauth.resource.href,
        }),
      });
      if (!response.ok) throw new Error("Preview exchange failed.");
      const tokens = await response.json(),
        mcp = new Client({ name: "Infomaniak AI private browser test", version: "1" });
      try {
        await mcp.connect(
          new StreamableHTTPClientTransport(oauth.resource, {
            requestInit: { headers: { authorization: "Bearer " + tokens.access_token } },
          }),
        );
        const tools = await mcp.listTools(),
          status = await mcp.callTool({ name: "infomaniak_status", arguments: {} }),
          accounts = await mcp.callTool({
            name: "infomaniak_read",
            arguments: { operation: "accounts.list" },
          });
        if (status.isError || accounts.isError) throw new Error("Account read failed.");
        const account = accounts.structuredContent.data[0];
        if (!account) throw new Error("No approved account.");
        const products = await mcp.callTool({
          name: "infomaniak_read",
          arguments: { operation: "products.list", arguments: { account_id: account.id } },
        });
        if (products.isError) throw new Error("Product read failed.");
        show(
          "Connection tested",
          `<div class="eyebrow">${live ? "Your account" : "Demo account"} · Read-only</div><h1>Your connection works.</h1><p class="lead">The MCP client received ${tools.tools.length} tools and read the account you approved. Writes are ${status.structuredContent.writes_enabled ? "enabled" : "disabled"}.</p><section class="panel"><h2>${e(account.name || "Account")} · ${e(account.id)}</h2><ul class="result-list">${products.structuredContent.data.map((p) => `<li><strong>${e(p.customer_name || p.name || p.id)}</strong><small>${e(p.service_name || p.type || "Product")} · ${e(p.id)}</small></li>`).join("") || "<li>No products returned for this account.</li>"}</ul><p><a class="button" href="${new URL("/connections", origin).href}">Manage connection</a></p><p class="muted">Disconnect there, then stop the test with Ctrl+C. This preview does not connect a native AI app or enable resource changes.</p></section>`,
        );
      } finally {
        await mcp.close();
      }
    })().catch(() => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.statusCode = 400;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        page(
          "Test could not finish",
          '<h1>The test could not finish.</h1><p>Check your token’s account and product permissions, then <a href="/start">start again</a>. No changes were requested.</p>',
          notice,
        ),
      );
    });
  });
  const close = () =>
    (closing ??= (async () => {
      await Promise.all([stop(browser), stop(server)]);
      store.close();
      key.fill(0);
      flows.clear();
      await rm(directory, { recursive: true, force: true });
    })());
  try {
    await listen(server, port);
    const callbackPort = await listen(browser, callbackPortRequested);
    callbackOrigin = new URL("http://127.0.0.1:" + callbackPort);
    client = await oauth.clientsStore.registerClient({
      client_name: live ? "Account preview" : "Demo AI",
      redirect_uris: [new URL("/callback", callbackOrigin).href],
      token_endpoint_auth_method: "none",
    });
    return { origin, testOrigin: callbackOrigin, directory, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2),
    live = args.includes("--live");
  const rest = args.filter((arg) => arg !== "--live");
  if (rest.length && !(rest.length === 2 && rest[0] === "--port" && /^\d+$/.test(rest[1]))) {
    console.error("Usage: npm run preview -- [--live] [--port 8789]");
    process.exitCode = 1;
  } else {
    try {
      const preview = await startPreview({ live, port: rest.length ? Number(rest[1]) : 8789 });
      console.log(`Private ${live ? "account" : "demo"} test: ${preview.testOrigin.href}`);
      console.log(`Homepage: ${preview.origin.href}`);
      console.log("Loopback only. Stop with Ctrl+C to remove temporary credentials.");
      for (const signal of ["SIGINT", "SIGTERM"])
        process.once(signal, () => {
          void preview.close().then(() => process.exit(0));
        });
    } catch {
      console.error("Could not start the private test. Check the ports or use --port 8889.");
      process.exitCode = 1;
    }
  }
}
