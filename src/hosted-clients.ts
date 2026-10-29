import type { Express } from "express";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
import { page, escapeHtml as e } from "./hosted-pages.js";

// Compatibility is evidence, not a promise inferred from the MCP protocol.
export const CLIENT_QUALIFICATION = {
  updated: "2026-10-29",
  service_version: version,
  protocol: {
    transport: "Streamable HTTP",
    oauth: "authorization code + S256 PKCE + dynamic registration",
    isolated_http_tests: true,
  },
  clients: [
    {
      id: "claude",
      name: "Claude web / Desktop",
      version: "Desktop 3.6556.2; web checked 2026-10-29",
      setup:
        "Hosted plugin 0.3.2 imported in Claude web: two skills and one connector. Desktop upload chooser did not accept the ZIP.",
      native_oauth:
        "Plugin/service 0.3.2: fresh Claude web browser consent and disconnect verified; 0.3.3 native confirmation pending",
      native_tools:
        "Six tools discovered on 0.3.2; model call blocked by Claude usage limit. Native confirmation not UI-qualified.",
    },
    {
      id: "claude-code",
      guide: "claude",
      name: "Claude Code",
      version: "2.1.310",
      setup:
        "Plugin 0.3.2 installed and enabled in an isolated fresh Claude Code profile; OAuth workflow pending",
      native_oauth:
        "Previous service 0.3.x: authenticated read/write test consent; candidate pending",
      native_tools: "Previous handshake only; model-driven call pending",
    },
    {
      id: "codex",
      name: "Codex",
      version: "0.164.0",
      setup:
        "Plugin 0.3.2 installed and enabled from a local marketplace in an isolated fresh CLI profile. Desktop automation unavailable in the test environment.",
      native_oauth:
        "Plugin/service 0.3.2: fresh browser and native PKCE/DCR consent verified, scoped preview, rejection before approval, cancellation and disconnect passed. Native confirmation in 0.3.3 pending.",
      native_tools:
        "Plugin/service 0.3.2: model-driven status, documentation search and guide read passed. 0.3.3 native confirmation requires separate UI qualification.",
    },
    {
      id: "cursor",
      name: "Cursor",
      version: "3.25.9",
      setup: "Fresh native setup attempted; account sign-in pending",
      native_oauth: "pending",
      native_tools: "pending",
    },
    {
      id: "vscode",
      name: "VS Code",
      version: "1.143.1",
      setup: "Official client installed; HTTP MCP configuration added to isolated fresh profile",
      native_oauth: "pending",
      native_tools: "pending",
    },
    {
      id: "chatgpt",
      name: "ChatGPT",
      version: "Web checked 2026-10-29",
      setup:
        "Private plugin 0.3.2 ZIP imported: one MCP server and two skills. No directory submission.",
      native_oauth: "pending",
      native_tools: "pending",
    },
    {
      id: "grok",
      name: "Grok",
      version: null,
      setup: "API integration instructions; fresh native qualification pending",
      native_oauth: "pending",
      native_tools: "pending",
    },
  ],
  meaning:
    "Pending means no completed native sign-in and model-driven tool workflow for this release. Archive import, prior-version RPCs, protocol fixtures and directory approval are separate evidence.",
};
export function mountClients(app: Express, origin: URL, notice?: string): void {
  app.get("/clients/status.json", (_req, res) => res.json(CLIENT_QUALIFICATION));
  app.get("/clients", (_req, res) =>
    res.type("html").send(
      page(
        "Client compatibility",
        `<h1>Client compatibility.</h1><p class="lead">Setup instructions and the checks we have actually completed.</p><p>${e(CLIENT_QUALIFICATION.meaning)}</p><div class="table-scroll"><table><thead><tr><th>Client</th><th>Setup</th><th>Native sign-in</th><th>Native tool call</th></tr></thead><tbody>${CLIENT_QUALIFICATION.clients.map((c) => `<tr><td><a href="/clients/${e(c.guide ?? c.id)}">${e(c.name)}</a>${c.version ? `<small>${e(c.version)}</small>` : ""}</td><td>${e(c.setup)}</td><td>${e(c.native_oauth)}</td><td>${e(c.native_tools)}</td></tr>`).join("")}</tbody></table></div><p>Updated ${e(CLIENT_QUALIFICATION.updated)} · service ${e(CLIENT_QUALIFICATION.service_version)}. <a href="/clients/status.json">Machine-readable status</a>.</p>`,
        notice,
        {
          origin: origin.origin,
          path: "/clients",
          description:
            "Infomaniak MCP client compatibility and qualification evidence for Claude Code, Codex, Cursor, VS Code, ChatGPT and Grok.",
        },
      ),
    ),
  );
}
