import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { PluginError } from "./errors.js";
const object = { type: "object" as const, properties: {}, additionalProperties: false };
const argumentsProperties = {
  operation: { type: "string" },
  arguments: { type: "object", additionalProperties: true },
};
const identityProperties = { plan_id: { type: "string", format: "uuid" } };
const tool = (
  name: string,
  description: string,
  properties: Record<string, object>,
  required: string[] = [],
  readOnly = true,
): Tool => ({
  name,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  annotations: {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly,
    idempotentHint: readOnly,
    openWorldHint: true,
  },
});
export const LEGACY_TOOLS: Tool[] = [
  {
    ...tool("infomaniak_status", "Check the configured adapter and available reads.", {}),
    inputSchema: object,
  },
  tool(
    "infomaniak_search",
    "Discover reviewed read operations and their schemas.",
    { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 5, default: 3 } },
    ["query"],
  ),
  tool(
    "infomaniak_read",
    "Call a reviewed read; writes and generic API calls are rejected.",
    argumentsProperties,
    ["operation"],
  ),
];
export const API_TOOLS: Tool[] = [
  tool(
    "infomaniak_status",
    "Check catalogue coverage, connection policy and reviewed capabilities.",
    {},
  ),
  tool(
    "infomaniak_search",
    "Discover public API operations. Catalogue entries may be unavailable; reviewed schemas load on demand.",
    {
      query: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 5, default: 3 },
      include_unavailable: { type: "boolean", default: true },
    },
    ["query"],
  ),
  tool(
    "infomaniak_catalogue",
    "Browse all public API metadata by product/method. Discovery does not grant execution.",
    {
      product: { type: "string" },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
  ),
  tool(
    "infomaniak_read",
    "Call a reviewed read within this connection's account/resource grants.",
    argumentsProperties,
    ["operation"],
  ),
  tool(
    "infomaniak_plan",
    "Inspect state and persist an exact proposed write. Does not approve or execute it.",
    argumentsProperties,
    ["operation"],
    false,
  ),
  tool(
    "infomaniak_execute",
    "Execute an independently approved plan once. Cannot create approval.",
    { ...identityProperties, plan_hash: { type: "string", pattern: "^[a-f0-9]{64}$" } },
    ["plan_id", "plan_hash"],
    false,
  ),
  tool(
    "infomaniak_operation",
    "Inspect an operation or reconcile uncertain/pending outcomes through reads.",
    { ...identityProperties, refresh: { type: "boolean", default: false } },
    ["plan_id"],
  ),
  tool(
    "infomaniak_cancel",
    "Cancel a planned or approved operation before execution; cannot cancel a sent provider request.",
    identityProperties,
    ["plan_id"],
    false,
  ),
];
export function createProtocol(
  dispatch: (name: string, args: unknown, signal: AbortSignal) => Promise<Record<string, unknown>>,
  advanced = false,
  discovery = false,
): Server {
  const server = new Server(
    { name: "infomaniak-ai", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: discovery ? API_TOOLS.slice(0, 4) : advanced ? API_TOOLS : LEGACY_TOOLS,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const data = await dispatch(
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
            ? "Arguments do not match this operation's schema."
            : "The plugin could not complete the operation.";
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({ error: true, code, message }) }],
      };
    }
  });
  return server;
}
