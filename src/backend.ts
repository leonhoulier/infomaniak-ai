import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { backendEnvironment, type Settings, verifyBackend } from "./config.js";
import { PluginError } from "./errors.js";

export interface Catalogue {
  tools: Tool[];
  name: string;
  version: string;
}

/** The plugin depends on this narrow interface, not the adapter's implementation. */
export interface Backend {
  catalogue(): Promise<Catalogue>;
  read(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
  close(): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 20_000;
const CATALOGUE_PAGE_LIMIT = 10;

/** Reuse a local MCP build over stdio with a pinned entry file and GET-only preload. */
export class McpBackend implements Backend {
  private client: Client | undefined;
  private pending: Promise<Catalogue> | undefined;

  constructor(private readonly settings: Settings) {}

  catalogue(): Promise<Catalogue> {
    this.pending ??= this.connect().catch(async (error: unknown) => {
      await this.close();
      if (error instanceof PluginError) throw error;
      throw new PluginError(
        "backend_unavailable",
        "Could not initialize the configured MCP backend. Check its build, configuration and protocol compatibility.",
      );
    });
    return this.pending;
  }

  private async connect(): Promise<Catalogue> {
    const path = await verifyBackend(this.settings);
    const client = new Client({ name: "infomaniak-ai-adapter", version: "0.1.0" });
    this.client = client;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", fileURLToPath(new URL("./guard.js", import.meta.url)), path],
      env: backendEnvironment(this.settings),
      stderr: "pipe",
    });
    // Drain untrusted adapter diagnostics; do not forward secrets or corrupt stdio.
    transport.stderr?.on("data", () => undefined);
    await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });
    const tools: Tool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < CATALOGUE_PAGE_LIMIT; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, {
        timeout: REQUEST_TIMEOUT_MS,
      });
      for (const tool of result.tools) {
        if (names.has(tool.name))
          throw new PluginError(
            "invalid_catalogue",
            "The backend advertised duplicate tool names.",
          );
        names.add(tool.name);
        tools.push(tool);
      }
      if (!result.nextCursor) {
        const info = client.getServerVersion();
        return { tools, name: info?.name ?? "unknown", version: info?.version ?? "unknown" };
      }
      if (cursors.has(result.nextCursor)) break;
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new PluginError(
      "invalid_catalogue",
      "Backend tool pagination is incomplete or repeats a cursor.",
    );
  }

  async read(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    await this.catalogue();
    if (!this.client) throw new PluginError("backend_unavailable", "The backend is not connected.");
    try {
      // Direct protocol request also accepts the adapter's typed error payloads.
      return await this.client.request(
        { method: "tools/call", params: { name, arguments: args } },
        CallToolResultSchema,
        { timeout: REQUEST_TIMEOUT_MS, ...(signal ? { signal } : {}) },
      );
    } catch {
      throw new PluginError(
        "read_failed",
        "The backend read failed or timed out. Check connectivity and retry the read when ready.",
      );
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.pending = undefined;
    if (client) await client.close();
  }
}
