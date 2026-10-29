import { z } from "zod";
import { McpBackend, type Backend } from "./backend.js";
import { authorize, credential, matchesSecret, type Access, type Principal } from "./access.js";
import { loadCatalogue, type ApiCatalogue, type CatalogueEntry } from "./catalogue.js";
import { boundedResult, PluginError } from "./errors.js";
import { Engine } from "./engine.js";
import { Journal } from "./journal.js";
import { PublicApi, RequestQueue, type Api } from "./provider.js";
import { inputSchema, OPERATIONS, type Operation } from "./registry.js";

const searchInput = z
  .object({
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(5).default(3),
    include_unavailable: z.boolean().default(true),
  })
  .strict();
const readInput = z
  .object({
    operation: z.string().max(120),
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
const identity = z.object({ plan_id: z.string().uuid() }).strict();
export class Application {
  readonly journal: Journal;
  readonly engines = new Map<string, Engine>();
  private readonly backends: Backend[] = [];
  private readonly secrets: string[];
  private constructor(
    readonly config: Access,
    readonly catalogue: ApiCatalogue,
    env: NodeJS.ProcessEnv,
    apiFactory?: (principal: Principal) => Api,
  ) {
    this.secrets = config.principals.map((p) => credential(p, env));
    if (
      new Set(this.secrets).size !== this.secrets.length ||
      this.secrets.some((token) =>
        config.principals.some(
          (p) =>
            matchesSecret(token, p.access_token_sha256) ||
            matchesSecret(token, p.approval_token_sha256),
        ),
      )
    )
      throw new PluginError(
        "invalid_configuration",
        "Each principal needs a separate provider credential, distinct from every MCP and human approval credential.",
      );
    this.journal = new Journal(config.state_directory);
    const queue = new RequestQueue();
    try {
      this.journal.claimRuntime();
      for (const p of config.principals) {
        if (p.operations.some((id) => !OPERATIONS.has(id)))
          throw new PluginError(
            "invalid_configuration",
            "The policy contains an operation without a reviewed handler.",
          );
        const token = credential(p, env);
        const backend = config.backend
          ? new McpBackend({
              INFOMANIAK_API_TOKEN: token,
              INFOMANIAK_MCP_SERVER_PATH: config.backend.path,
              INFOMANIAK_MCP_SHA256: config.backend.sha256,
            })
          : undefined;
        if (backend) this.backends.push(backend);
        const controlled = backend
          ? {
              catalogue: () => backend.catalogue(),
              read: (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
                queue.run(() => backend.read(name, args, signal)),
              close: () => backend.close(),
            }
          : undefined;
        this.engines.set(
          p.id,
          new Engine(
            this.journal,
            p,
            apiFactory?.(p) ?? new PublicApi(token, queue),
            this.secrets,
            controlled,
          ),
        );
      }
    } catch (e) {
      this.journal.close();
      throw e;
    }
  }
  static async create(
    config: Access,
    env: NodeJS.ProcessEnv = process.env,
    apiFactory?: (p: Principal) => Api,
  ): Promise<Application> {
    return new Application(config, await loadCatalogue(), env, apiFactory);
  }
  private engine(principal: Principal): Engine {
    const engine = this.engines.get(principal.id);
    if (!engine) throw new PluginError("access_denied", "Unknown connection.");
    return engine;
  }
  private enabled(p: Principal, op: Operation): boolean {
    return p.operations.includes(op.id) && (!op.write || p.writes !== "disabled");
  }
  private descriptor(
    p: Principal,
    row: CatalogueEntry | undefined,
    op?: Operation,
  ): Record<string, unknown> {
    return {
      operation: op?.id ?? row!.id,
      product: op?.product ?? row!.product,
      summary: op?.summary ?? row!.summary,
      method: op?.method ?? row!.method,
      path: op?.path ?? row!.path,
      documented: !!row,
      implemented: !!op,
      policy_enabled: op ? this.enabled(p, op) : false,
      adapter_available: op ? !op.requiresBackend || !!this.config.backend : false,
      live_verified: false,
      permissions_verified: false,
      ...(op
        ? {
            write: op.write,
            revision: op.revision,
            ...(op.notes ? { notes: op.notes } : {}),
            input_schema: inputSchema(op),
          }
        : { reason: "Catalogue metadata only. No reviewed schema, handler or execution policy." }),
      ...(row ? { documentation: row.documentation } : {}),
    };
  }
  async dispatch(p: Principal, name: string, input: unknown): Promise<Record<string, unknown>> {
    if (JSON.stringify(input).length > 64_000)
      throw new PluginError("invalid_input", "Tool input exceeds its budget.");
    const engine = this.engine(p);
    let result: Record<string, unknown>;
    if (name === "infomaniak_status") {
      z.object({}).strict().parse(input);
      result = {
        stage: "controlled API runtime",
        mode: this.config.remote ? "configured for remote access" : "local",
        catalogue: {
          operations: this.catalogue.operations.length,
          products: new Set(this.catalogue.operations.map((r) => r.product)).size,
          checked_at: this.catalogue.checked_at,
        },
        principal: p.id,
        accounts: p.accounts,
        writes_enabled: p.writes !== "disabled",
        write_policy: p.writes,
        available_reads: [...OPERATIONS.values()]
          .filter(
            (o) => !o.write && this.enabled(p, o) && (!o.requiresBackend || !!this.config.backend),
          )
          .map((o) => o.id),
        available_writes: [...OPERATIONS.values()]
          .filter((o) => o.write && this.enabled(p, o))
          .map((o) => o.id),
        permissions_verified: false,
        deployment_enabled: false,
        approval:
          "Independent human key through the approval UI or administrator CLI; no MCP approval tool.",
        approval_url: this.config.remote ? this.config.remote.public_origin + "/approvals" : null,
        note: "Catalogue coverage is not execution coverage. Reviewed handlers have fixture coverage; check validation notes for live evidence.",
      };
    } else if (name === "infomaniak_search") {
      const args = searchInput.parse(input),
        words = args.query.toLowerCase().split(/\s+/);
      const byRoute = new Map([...OPERATIONS.values()].map((o) => [o.method + " " + o.path, o]));
      const descriptors = this.catalogue.operations.map((row) =>
        this.descriptor(p, row, byRoute.get(row.method + " " + row.path)),
      );
      for (const op of OPERATIONS.values())
        if (!this.catalogue.operations.some((r) => r.method === op.method && r.path === op.path))
          descriptors.push(this.descriptor(p, undefined, op));
      const ranked = descriptors
        .filter((d) => args.include_unavailable || (d.policy_enabled && d.adapter_available))
        .map((d) => ({
          d,
          score: words.reduce(
            (n, w) =>
              n +
              ((d.operation + " " + d.product + " " + d.summary + " " + d.path)
                .toLowerCase()
                .includes(w)
                ? 1
                : 0),
            0,
          ),
        }))
        .filter((r) => r.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            Number(b.d.policy_enabled) - Number(a.d.policy_enabled) ||
            String(a.d.operation).localeCompare(String(b.d.operation)),
        );
      result = {
        operations: ranked.slice(0, args.limit).map((r) => r.d),
        matching_operations: ranked.length,
      };
    } else if (name === "infomaniak_catalogue") {
      const a = z
        .object({
          product: z.string().max(100).optional(),
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
          offset: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(50).default(20),
        })
        .strict()
        .parse(input);
      const rows = this.catalogue.operations.filter(
        (r) => (!a.product || r.product === a.product) && (!a.method || r.method === a.method),
      );
      result = {
        products: [...new Set(this.catalogue.operations.map((r) => r.product))],
        total: rows.length,
        offset: a.offset,
        next_offset: a.offset + a.limit < rows.length ? a.offset + a.limit : null,
        operations: rows.slice(a.offset, a.offset + a.limit).map((row) => {
          const op = [...OPERATIONS.values()].find(
            (o) => o.method === row.method && o.path === row.path,
          );
          // Bulk browsing excludes schemas; search loads them on demand.
          const { input_schema: _, ...d } = this.descriptor(p, row, op);
          return d;
        }),
      };
    } else if (name === "infomaniak_read") {
      const args = readInput.parse(input);
      result = await engine.read(args.operation, args.arguments);
    } else if (name === "infomaniak_plan") {
      const args = readInput.parse(input);
      result = { plan: await engine.plan(args.operation, args.arguments), approval_required: true };
    } else if (name === "infomaniak_execute") {
      const args = identity
        .extend({ plan_hash: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(input);
      result = { plan: await engine.execute(args.plan_id, args.plan_hash) };
    } else if (name === "infomaniak_operation") {
      const args = identity
        .extend({ refresh: z.boolean().default(false) })
        .strict()
        .parse(input);
      result = {
        plan: args.refresh ? await engine.reconcile(args.plan_id) : engine.status(args.plan_id),
      };
    } else if (name === "infomaniak_cancel") {
      const args = identity.parse(input);
      result = { plan: engine.cancel(args.plan_id) };
    } else throw new PluginError("unknown_tool", "Unknown plugin tool.");
    return boundedResult(result, this.secrets);
  }
  approve(p: Principal, id: string, hash: string): void {
    const plan = this.journal.get(id, p.id),
      op = OPERATIONS.get(plan.operation);
    if (!op) throw new PluginError("operation_denied", "Unknown operation.");
    authorize(p, op.id, plan.args.account_id, op.resource?.(plan.args), true);
    this.journal.approve(id, p.id, hash);
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.engines.values()].map((e) => e.close()));
    await Promise.allSettled(this.backends.map((b) => b.close()));
    this.journal.close();
  }
}
