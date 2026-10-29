import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from "node:http";
import { randomBytes } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Principal } from "./access.js";
import { matchesSecret } from "./access.js";
import type { Application } from "./application.js";
import { PluginError } from "./errors.js";
import { handleWriteApi } from "./write-api.js";
import { createProtocol } from "./protocol.js";

const escape = (v: unknown) =>
  String(v).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const html = (title: string, body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{font:16px/1.5 system-ui;max-width:880px;margin:40px auto;padding:0 20px;color:#17212b;background:#fafbfc}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef1f5;padding:16px;border-radius:8px}input,button{font:inherit;padding:8px;margin:6px 0}label{display:block}button{cursor:pointer}a{color:#1458a5}.warning{padding:16px;background:#fff2dc;border-left:4px solid #a76000}</style><h1>${escape(title)}</h1>${body}</html>`;
interface Session {
  principal: Principal;
  csrf: string;
  expires: number;
}
function cookies(req: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const split = part.indexOf("=");
    if (split < 0) continue;
    const key = part.slice(0, split).trim(),
      value = part.slice(split + 1).trim();
    if (Object.hasOwn(result, key)) return {};
    result[key] = value;
  }
  return result;
}
async function body(req: IncomingMessage, max = 64_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let bytes = 0,
      failed = false;
    const chunks: Buffer[] = [];
    req.on("data", (part: Buffer) => {
      if (failed) return;
      bytes += part.length;
      if (bytes > max) {
        failed = true;
        chunks.length = 0;
        reject(new PluginError("request_too_large", "Request exceeds its size limit."));
        return;
      }
      chunks.push(part);
    });
    req.once("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.once("error", () =>
      reject(new PluginError("invalid_input", "Could not read the complete request.")),
    );
  });
}
export function createRemote(app: Application): HttpServer {
  const remote = app.config.remote;
  if (!remote)
    throw new PluginError(
      "invalid_configuration",
      "Configure an explicit remote origin and listener first.",
    );
  const origin = new URL(remote.public_origin),
    secure = origin.protocol === "https:";
  const sessions = new Map<string, Session>(),
    attempts = new Map<string, { count: number; until: number }>(),
    inflight = new Map<string, number>();
  const cookieName = secure ? "__Secure-ik_approval" : "ik_approval";
  const send = (
    res: ServerResponse,
    status: number,
    text: string,
    type = "text/html; charset=utf-8",
  ) => {
    res.writeHead(status, { "content-type": type });
    res.end(text);
  };
  const server = createServer((req, res) => {
    void (async () => {
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      if (secure) res.setHeader("strict-transport-security", "max-age=31536000");
      if (
        req.headers.host !== origin.host ||
        (req.headers.origin && req.headers.origin !== origin.origin)
      ) {
        send(res, 403, "Forbidden", "text/plain");
        return;
      }
      const url = new URL(req.url ?? "/", origin);
      if (url.search || url.username || url.password) {
        send(res, 400, "Query parameters are not accepted.", "text/plain");
        return;
      }
      if (url.pathname === "/healthz") {
        send(res, 200, '{"ok":true}', "application/json");
        return;
      }
      if (url.pathname === "/mcp" || url.pathname.startsWith("/api/v1/")) {
        const match = /^Bearer ([^\s]{32,256})$/.exec(req.headers.authorization ?? "");
        const p = match
          ? app.config.principals.find((p) => matchesSecret(match[1]!, p.access_token_sha256))
          : undefined;
        if (!p) {
          res.setHeader("www-authenticate", 'Bearer realm="infomaniak-ai"');
          send(
            res,
            401,
            url.pathname.startsWith("/api/v1/") ? '{"error":"unauthorized"}' : "Unauthorized",
            url.pathname.startsWith("/api/v1/") ? "application/json" : "text/plain",
          );
          return;
        }
        if (url.pathname.startsWith("/api/v1/")) {
          if ((inflight.get(p.id) ?? 0) >= 8) {
            send(res, 429, '{"error":"too_many_requests"}', "application/json");
            return;
          }
          inflight.set(p.id, (inflight.get(p.id) ?? 0) + 1);
          try {
            await handleWriteApi(req, res, app, p, url.pathname, () => body(req, 16_384));
          } finally {
            inflight.set(p.id, (inflight.get(p.id) ?? 1) - 1);
          }
          return;
        }
        if (req.method !== "POST") {
          res.setHeader("allow", "POST");
          send(res, 405, "Stateless MCP accepts POST.", "text/plain");
          return;
        }
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          send(res, 415, "Expected JSON.", "text/plain");
          return;
        }
        if ((inflight.get(p.id) ?? 0) >= 8) {
          res.setHeader("retry-after", "5");
          send(res, 429, "Too many concurrent requests.", "text/plain");
          return;
        }
        inflight.set(p.id, (inflight.get(p.id) ?? 0) + 1);
        const protocol = createProtocol((name, args) => app.dispatch(p, name, args), true);
        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
        try {
          let input: unknown;
          try {
            input = JSON.parse(await body(req));
          } catch (error) {
            if (error instanceof PluginError) throw error;
            throw new PluginError("invalid_input", "Expected valid JSON.");
          }
          // SDK HTTP accessors include explicit undefined; its Transport interface
          // uses optional properties. Runtime contracts match under exactOptionalPropertyTypes.
          await protocol.connect(transport as unknown as Transport);
          await transport.handleRequest(req, res, input);
        } finally {
          inflight.set(p.id, (inflight.get(p.id) ?? 1) - 1);
          await protocol.close();
        }
        return;
      }
      if (!url.pathname.startsWith("/approvals")) {
        send(res, 404, "Not found.", "text/plain");
        return;
      }
      const now = Date.now();
      for (const [key, s] of sessions) if (s.expires <= now) sessions.delete(key);
      for (const [key, a] of attempts) if (a.until <= now) attempts.delete(key);
      if (url.pathname === "/approvals/login" && req.method === "GET") {
        send(
          res,
          200,
          html(
            "Infomaniak AI approvals",
            '<p>Sign in with your separate human approval key. The MCP connection token cannot approve changes.</p><form method="post" action="/approvals/login"><label>Connection name <input name="principal" required maxlength="64" autocomplete="username"></label><label>Human approval key <input name="key" type="password" required autocomplete="current-password"></label><button>Sign in</button></form>',
          ),
        );
        return;
      }
      if (url.pathname === "/approvals/login" && req.method === "POST") {
        if (req.headers.origin !== origin.origin) {
          send(res, 403, "Forbidden", "text/plain");
          return;
        }
        if (!req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) {
          send(res, 415, "Expected form.", "text/plain");
          return;
        }
        const ip = req.socket.remoteAddress ?? "unknown",
          attempt = attempts.get(ip) ?? { count: 0, until: now + 60_000 };
        if (attempt.count >= 10 || attempts.size >= 1000) {
          send(res, 429, "Try again later.", "text/plain");
          return;
        }
        attempt.count++;
        attempts.set(ip, attempt);
        const form = new URLSearchParams(await body(req, 4096));
        const p = app.config.principals.find((p) => p.id === form.get("principal"));
        if (!p || !matchesSecret(form.get("key") ?? "", p.approval_token_sha256)) {
          send(res, 401, "Sign-in failed.", "text/plain");
          return;
        }
        if (sessions.size >= 1000) {
          send(res, 503, "Approval sessions are full.", "text/plain");
          return;
        }
        const token = randomBytes(32).toString("hex");
        sessions.set(token, {
          principal: p,
          csrf: randomBytes(32).toString("hex"),
          expires: now + 30 * 60_000,
        });
        res.setHeader(
          "set-cookie",
          cookieName +
            "=" +
            token +
            "; HttpOnly; SameSite=Strict; Path=/approvals; Max-Age=1800" +
            (secure ? "; Secure" : ""),
        );
        res.writeHead(303, { location: "/approvals" });
        res.end();
        return;
      }
      const session = sessions.get(cookies(req)[cookieName] ?? "");
      if (!session) {
        res.writeHead(303, { location: "/approvals/login" });
        res.end();
        return;
      }
      if (url.pathname === "/approvals/logout" && req.method === "POST") {
        if (
          req.headers.origin !== origin.origin ||
          !req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")
        ) {
          send(res, 403, "Forbidden", "text/plain");
          return;
        }
        const form = new URLSearchParams(await body(req, 4096));
        if (form.get("csrf") !== session.csrf) {
          send(res, 403, "Forbidden", "text/plain");
          return;
        }
        sessions.delete(cookies(req)[cookieName]!);
        res.setHeader(
          "set-cookie",
          cookieName +
            "=; HttpOnly; SameSite=Strict; Path=/approvals; Max-Age=0" +
            (secure ? "; Secure" : ""),
        );
        res.writeHead(303, { location: "/approvals/login" });
        res.end();
        return;
      }
      const detail = /^\/approvals\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (url.pathname === "/approvals" && req.method === "GET") {
        const rows = app.journal.list(session.principal.id);
        send(
          res,
          200,
          html(
            "Review changes",
            "<p>Signed in as " +
              escape(session.principal.id) +
              ". Every action is bound to one exact plan.</p><ul>" +
              rows
                .map(
                  (p) =>
                    '<li><a href="/approvals/' +
                    escape(p.id) +
                    '">' +
                    escape(p.operation) +
                    "</a> — " +
                    escape(p.state) +
                    "</li>",
                )
                .join("") +
              '</ul><form method="post" action="/approvals/logout"><input type="hidden" name="csrf" value="' +
              escape(session.csrf) +
              '"><button>Sign out</button></form>',
          ),
        );
        return;
      }
      if (detail && req.method === "GET") {
        const id = detail[1]!,
          data = await app.dispatch(session.principal, "infomaniak_operation", { plan_id: id });
        const p = app.journal.get(id, session.principal.id);
        send(
          res,
          200,
          html(
            "Review " + p.operation,
            '<p class="warning">' +
              escape(p.change.impact) +
              "</p><p>" +
              escape(p.change.recovery) +
              "</p><p>Expires: " +
              escape(new Date(p.expires_at).toISOString()) +
              ". Live compatibility must be established on disposable resources before production use.</p><pre>" +
              escape(JSON.stringify(data, null, 2)) +
              "</pre>" +
              (p.state === "planned"
                ? '<form method="post" action="/approvals/' +
                  escape(id) +
                  '"><input type="hidden" name="csrf" value="' +
                  escape(session.csrf) +
                  '"><input type="hidden" name="plan_hash" value="' +
                  escape(p.hash) +
                  '"><label>Type APPROVE after reviewing the account, resource and complete change <input name="ack" required autocomplete="off"></label><button>Approve this exact plan</button></form>'
                : "<p>This plan cannot be approved in its current state.</p>") +
              '<p><a href="/approvals">All changes</a></p>',
          ),
        );
        return;
      }
      if (detail && req.method === "POST") {
        if (req.headers.origin !== origin.origin) {
          send(res, 403, "Forbidden", "text/plain");
          return;
        }
        if (!req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) {
          send(res, 415, "Expected form.", "text/plain");
          return;
        }
        const form = new URLSearchParams(await body(req, 4096));
        if (form.get("csrf") !== session.csrf || form.get("ack") !== "APPROVE") {
          send(res, 403, "Review and acknowledge this plan first.", "text/plain");
          return;
        }
        app.approve(session.principal, detail[1]!, form.get("plan_hash") ?? "");
        // Rotate after each decision to prevent a form from authorizing another plan.
        session.csrf = randomBytes(32).toString("hex");
        res.writeHead(303, { location: "/approvals/" + detail[1] });
        res.end();
        return;
      }
      send(res, 405, "Method not allowed.", "text/plain");
    })().catch((error) => {
      if (!res.headersSent)
        send(
          res,
          error instanceof PluginError ? 400 : 500,
          error instanceof PluginError ? error.message : "Request failed.",
          "text/plain",
        );
      else res.end();
    });
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 40;
  server.maxConnections = 100;
  return server;
}
