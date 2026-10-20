import { z } from "zod";
import { loadCatalogue, type ApiCatalogue } from "./catalogue.js";
import { boundedResult, PluginError } from "./errors.js";
import { PublicApi, RequestQueue, list, object, type Api } from "./provider.js";
import { createReadOnlyFetch } from "./policy.js";

/** Public onboarding: only the user's token, no author's account, backend or state directory. */
export class Discovery {
  private accounts: Set<number> | undefined;
  private constructor(
    private readonly token: string,
    private readonly catalogue: ApiCatalogue,
    private readonly api: Api,
  ) {}
  static async create(token: string, api?: Api): Promise<Discovery> {
    return new Discovery(
      token,
      await loadCatalogue(),
      api ?? new PublicApi(token, new RequestQueue(), createReadOnlyFetch(fetch)),
    );
  }
  private async accountList(): Promise<Record<string, unknown>[]> {
    const rows = list(await this.api.request("GET", "/1/accounts"))
      .map(object)
      .map((r) => ({ id: r.id, name: r.name ?? r.customer_name ?? "" }));
    if (rows.some((r) => !Number.isSafeInteger(r.id) || Number(r.id) <= 0))
      throw new PluginError("invalid_response", "Invalid account inventory.");
    this.accounts = new Set(rows.map((r) => Number(r.id)));
    return rows;
  }
  async dispatch(name: string, input: unknown): Promise<Record<string, unknown>> {
    if (JSON.stringify(input).length > 32_000)
      throw new PluginError("invalid_input", "Input exceeds its budget.");
    let result: Record<string, unknown>;
    if (name === "infomaniak_status") {
      z.object({}).strict().parse(input);
      result = {
        mode: "discovery-only",
        writes_enabled: false,
        catalogue: {
          operations: this.catalogue.operations.length,
          products: new Set(this.catalogue.operations.map((r) => r.product)).size,
        },
        available_reads: ["accounts.list", "products.list"],
        permissions_verified: false,
        next_step:
          "Use your own account/product IDs to initialize a private policy with admin.js init. Scoped reads and independently approved writes require that policy.",
      };
    } else if (name === "infomaniak_read") {
      const args = z
        .object({
          operation: z.enum(["accounts.list", "products.list"]),
          arguments: z.record(z.unknown()).default({}),
        })
        .strict()
        .parse(input);
      if (args.operation === "accounts.list") {
        z.object({}).strict().parse(args.arguments);
        result = { operation: args.operation, data: await this.accountList() };
      } else {
        const a = z
          .object({ account_id: z.number().int().positive().safe() })
          .strict()
          .parse(args.arguments);
        if (!this.accounts) await this.accountList();
        if (!this.accounts!.has(a.account_id))
          throw new PluginError("access_denied", "Select an account returned for this token.");
        const rows = list(await this.api.request("GET", "/1/products?account_id=" + a.account_id));
        result = {
          operation: args.operation,
          data: rows.map((value) => {
            const r = object(value);
            return Object.fromEntries(
              ["id", "name", "type", "service_id", "account_id", "status", "fqdn"]
                .filter((k) => Object.hasOwn(r, k))
                .map((k) => [k, r[k]]),
            );
          }),
        };
      }
    } else if (name === "infomaniak_catalogue" || name === "infomaniak_search") {
      const searching = name === "infomaniak_search";
      const a = z
        .object({
          query: z.string().trim().min(1).max(200).optional(),
          product: z.string().max(100).optional(),
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
          offset: z.number().int().min(0).default(0),
          limit: z
            .number()
            .int()
            .min(1)
            .max(searching ? 5 : 50)
            .default(searching ? 3 : 20),
          include_unavailable: z.boolean().default(true),
        })
        .strict()
        .parse(input);
      if (searching && !a.query) throw new PluginError("invalid_input", "Provide a search query.");
      const words = a.query?.toLowerCase().split(/\s+/) ?? [];
      const rows = this.catalogue.operations
        .map((r) => {
          const op =
            r.method === "GET" && r.path === "/1/accounts"
              ? "accounts.list"
              : r.method === "GET" && r.path === "/1/products"
                ? "products.list"
                : undefined;
          return {
            ...r,
            operation: op ?? r.id,
            implemented: !!op,
            policy_enabled: !!op,
            write: op ? false : null,
            ...(op
              ? {
                  input_schema: {
                    type: "object",
                    properties:
                      op === "accounts.list" ? {} : { account_id: { type: "integer", minimum: 1 } },
                    required: op === "accounts.list" ? [] : ["account_id"],
                    additionalProperties: false,
                  },
                }
              : {
                  reason:
                    "Discovery metadata only; configure reviewed operations in a private policy.",
                }),
          };
        })
        .filter(
          (r) =>
            (!a.product || r.product === a.product) &&
            (!a.method || r.method === a.method) &&
            (a.include_unavailable || r.implemented),
        )
        .map((r) => ({
          r,
          score: words.filter((w) =>
            (r.operation + " " + r.product + " " + r.summary + " " + r.path)
              .toLowerCase()
              .includes(w),
          ).length,
        }))
        .filter((x) => !searching || x.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            Number(b.r.implemented) - Number(a.r.implemented) ||
            a.r.id.localeCompare(b.r.id),
        );
      result = {
        total: rows.length,
        products: [...new Set(this.catalogue.operations.map((r) => r.product))],
        next_offset: a.offset + a.limit < rows.length ? a.offset + a.limit : null,
        operations: rows.slice(a.offset, a.offset + a.limit).map((x) => x.r),
      };
    } else
      throw new PluginError(
        "operation_denied",
        "This installation is read-only discovery. Configure a scoped policy for additional operations; no write can be enabled through a tool argument.",
      );
    return boundedResult(result, [this.token]);
  }
}
