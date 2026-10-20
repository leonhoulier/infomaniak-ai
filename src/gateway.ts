import { z } from "zod";

import type { Backend, Catalogue } from "./backend.js";
import { boundedResult, PluginError, redact } from "./errors.js";
import { authorizeRead, READS, type ReadName } from "./policy.js";

const SearchInput = z
  .object({
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(5).default(3),
  })
  .strict();
const ReadInput = z
  .object({ operation: z.string().min(1).max(120), arguments: z.record(z.unknown()).default({}) })
  .strict();

function admitted(catalogue: Catalogue): Set<ReadName> {
  const names = new Set(
    catalogue.tools
      .filter((tool) => tool.annotations?.readOnlyHint === true)
      .map((tool) => tool.name),
  );
  return new Set(
    catalogue.tools
      .filter(
        (tool) =>
          Object.hasOwn(READS, tool.name) &&
          tool.annotations?.readOnlyHint === true &&
          // The original VPS list is Manager-only. The reviewed token-support patch
          // introduces this companion tool; legacy builds must report the gap.
          (tool.name !== "infomaniak_list_vps" || names.has("infomaniak_get_vps_firewall")),
      )
      .map((tool) => tool.name as ReadName),
  );
}

/** A small stable interface over the reviewed subset of upstream operations. */
export class Gateway {
  constructor(
    private readonly backend: Backend,
    private readonly secrets: readonly string[] = [],
  ) {}

  async dispatch(
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let result: Record<string, unknown>;
    if (name === "infomaniak_status") {
      z.object({}).strict().parse(input);
      const catalogue = await this.backend.catalogue();
      const available = admitted(catalogue);
      result = {
        stage: "read-only foundation",
        writes_enabled: false,
        deployment_enabled: false,
        backend: { name: catalogue.name, version: catalogue.version, browser_auth: "disabled" },
        permissions_verified: false,
        available_reads: [...available],
        unavailable_reads: Object.keys(READS).filter(
          (operation) => !available.has(operation as ReadName),
        ),
        note: "Availability comes from the adapter catalogue, not a live permissions check. Preview deployment, promotion and rollback are not implemented.",
      };
    } else if (name === "infomaniak_search") {
      const args = SearchInput.parse(input);
      const catalogue = await this.backend.catalogue();
      const available = admitted(catalogue);
      const words = args.query.toLowerCase().split(/\s+/);
      const operations = catalogue.tools
        .filter((tool) => available.has(tool.name as ReadName))
        .map((tool) => {
          const policy = READS[tool.name as ReadName];
          const text = `${tool.name} ${policy.area} ${policy.description}`.toLowerCase();
          return { tool, policy, score: words.filter((word) => text.includes(word)).length };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
        .slice(0, args.limit)
        .map(({ tool, policy }) => ({
          operation: tool.name,
          area: policy.area,
          description: policy.description,
          explicit_account_required: policy.account,
          input_schema: {
            ...tool.inputSchema,
            required: [
              ...new Set([
                ...(tool.inputSchema.required ?? []),
                ...(policy.account ? ["account_id"] : []),
              ]),
            ],
          },
        }));
      result = { operations, read_only: true };
    } else if (name === "infomaniak_read") {
      const args = ReadInput.parse(input);
      const operation = authorizeRead(args.operation, args.arguments);
      if (JSON.stringify(args.arguments).length > 64_000) {
        throw new PluginError("invalid_input", "Read arguments exceed the input budget.");
      }
      const catalogue = await this.backend.catalogue();
      if (!admitted(catalogue).has(operation)) {
        throw new PluginError(
          "operation_unavailable",
          "This read is not supported by the configured backend in token-only mode. Check status and select an available operation.",
        );
      }
      const response = await this.backend.read(operation, args.arguments, signal);
      if (response.isError) {
        const message =
          response.content.find((part) => part.type === "text")?.text ?? "Upstream read failed.";
        throw new PluginError(
          "upstream_error",
          String(redact(message, this.secrets)).slice(0, 600),
        );
      }
      result = { operation, data: response.structuredContent ?? { content: response.content } };
    } else {
      throw new PluginError("unknown_tool", "Unknown plugin tool. Use status, search or read.");
    }
    return boundedResult(result, this.secrets);
  }
}
