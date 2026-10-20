import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export async function startBackend(mode = "normal") {
  const tool = {
    name: "infomaniak_list_domains",
    description: "Fixture domains",
    inputSchema: {
      type: "object",
      properties: { account_id: { type: "integer" }, simulate: { type: "string" } },
    },
    annotations: { readOnlyHint: true },
  };
  const server = new Server(
    { name: "fixture-adapter", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () =>
    mode === "loop"
      ? { tools: [], nextCursor: "repeated-cursor" }
      : {
          tools:
            mode === "duplicate" ? [tool, tool] : [tool, { ...tool, name: "infomaniak_api_call" }],
        },
  );
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    if (args.simulate === "error")
      return {
        isError: true,
        content: [{ type: "text", text: `Bearer ${process.env.INFOMANIAK_API_TOKEN}` }],
        structuredContent: { error: true, error_type: "auth_failure" },
      };
    if (args.simulate === "write") {
      try {
        await fetch("https://api.infomaniak.com/2/zones/example.com/records", {
          method: "POST",
          body: "{}",
        });
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error.message }] };
      }
      throw new Error("Write must not be allowed in a fixture");
    }
    const data = {
      account_id: args.account_id,
      domains: [{ id: 1, customer_name: "example.com" }],
      adapter_auth: process.env.INFOMANIAK_AUTH_MODE,
      adapter_read_only: process.env.INFOMANIAK_READ_ONLY,
      unexpected_env: Object.keys(process.env).some((key) =>
        ["UNRELATED_CREDENTIAL", "INFOMANIAK_SASESSION", "INFOMANIAK_XSRF_TOKEN"].includes(key),
      ),
    };
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
  });
  await server.connect(new StdioServerTransport());
}
