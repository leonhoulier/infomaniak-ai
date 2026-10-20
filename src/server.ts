#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

import { McpBackend } from "./backend.js";
import { loadSettings, verifyBackend } from "./config.js";
import { PluginError } from "./errors.js";
import { Gateway } from "./gateway.js";

const TOOLS = [
  {
    name: "infomaniak_status",
    description:
      "Check the configured adapter and available reads. Does not verify API permissions or enable deployments.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
  },
  {
    name: "infomaniak_search",
    description: "Discover relevant approved reads and their argument schemas on demand.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 5, default: 3 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "infomaniak_read",
    description:
      "Call a reviewed read operation discovered through search. Writes and generic API calls are rejected.",
    inputSchema: {
      type: "object" as const,
      properties: {
        operation: { type: "string" },
        arguments: { type: "object", additionalProperties: true },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
].map((tool) => ({
  ...tool,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
}));

async function main(): Promise<void> {
  const settings = loadSettings();
  if (process.argv.includes("--doctor")) {
    await verifyBackend(settings);
    console.log(
      JSON.stringify({
        configured: true,
        backend_integrity: "matched",
        browser_auth: "disabled",
        mode: "read-only",
        api_permissions_tested: false,
      }),
    );
    return;
  }
  const backend = new McpBackend(settings);
  const gateway = new Gateway(backend, [settings.INFOMANIAK_API_TOKEN]);
  const server = new Server(
    { name: "infomaniak-ai", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const data = await gateway.dispatch(
        request.params.name,
        request.params.arguments ?? {},
        extra.signal,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: data,
      };
    } catch (error) {
      const code =
        error instanceof PluginError
          ? error.code
          : error instanceof ZodError
            ? "invalid_input"
            : "internal_error";
      const message =
        error instanceof PluginError
          ? error.message
          : error instanceof ZodError
            ? "Arguments do not match this tool's input schema."
            : "The plugin could not complete the read.";
      // Do not attach the success schema or raw exception details to failures.
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({ error: true, code, message }) }],
      };
    }
  });
  const shutdown = async (): Promise<void> => {
    await backend.close();
    await server.close();
  };
  server.onclose = () => {
    void backend.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      error: true,
      code: error instanceof PluginError ? error.code : "startup_failed",
      message: error instanceof PluginError ? error.message : "Plugin initialization failed.",
    }),
  );
  process.exitCode = 1;
});
