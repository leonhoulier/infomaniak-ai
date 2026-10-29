import { generateKeyPairSync, randomUUID, createPublicKey } from "node:crypto";
import type { Express, Request } from "express";
import { z } from "zod";
import { HostedStore, opaque, fingerprint } from "./hosted-store.js";
import type { Grant, Browser } from "./hosted-oauth.js";
import { DEPLOY_SCOPE } from "./hosted-resources.js";
import {
  AppDefinition,
  Job,
  Report,
  signed,
  validSignature,
  type JobResult,
} from "./runner-contract.js";
import { DEPLOYMENT_OPERATIONS } from "./deployment-operations.js";
import { Engine } from "./engine.js";
import type { HostedWriteJournal } from "./hosted-writes.js";
import { inputSchema } from "./registry.js";
import { object, type Api } from "./provider.js";
import { PluginError } from "./errors.js";
import type { Principal } from "./access.js";
import type { Plan } from "./journal.js";
import { escapeHtml as e } from "./hosted-pages.js";

interface Runner {
  id: string;
  owner: string;
  account: number;
  publicKey: string;
  apps: AppDefinition[];
  active: boolean;
  sequence: number;
  seen: number;
  report?: Report;
}
interface QueuedJob {
  job: Job;
  grant: string;
  owner: string;
  state: "queued" | "sent" | "finished";
  result?: JobResult;
}
interface Pair {
  publicKey: string;
  apps: AppDefinition[];
  runner?: string;
  expires: number;
}
const signingKeys = () => {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
};
export class HostedDeployments {
  private keys: ReturnType<typeof signingKeys>;
  constructor(
    private store: HostedStore,
    private journal: HostedWriteJournal,
  ) {
    this.keys = store.get("meta", "runner-signing-key") ?? signingKeys();
    store.put("meta", "runner-signing-key", this.keys, Number.MAX_SAFE_INTEGER);
    // Older releases embedded job/log payloads in long-lived health snapshots.
    // Scrub them even if a runner never polls after the upgrade, preserving expiry.
    store.atomic(() => {
      for (const { id, value } of store.list<Runner>("runner")) {
        if (value.report?.results.length) {
          value.report.results = [];
          store.replaceValue("runner", id, value);
        }
      }
      for (const { id, value } of store.list<QueuedJob>("runner-job"))
        if (value.job.action === "logs")
          store.capExpiry("runner-job", id, store.now() + 7 * 86400000);
      for (const { id, value } of store.list<Runner>("runner"))
        if (!value.active && !this.awaitingCompletion(id))
          store.capExpiry("runner", id, store.now() + 7 * 86400000);
    });
  }
  private awaitingCompletion(runner: string, completed: string[] = []): boolean {
    return this.store
      .list<QueuedJob>("runner-job")
      .some(
        ({ id, value }) =>
          value.job.runner === runner &&
          value.job.action !== "logs" &&
          value.state !== "queued" &&
          (!value.result || value.result.state === "unknown") &&
          !completed.includes(id),
      );
  }
  review(id: string, grant: Grant, plan: string, hash: string): Plan {
    const current = this.journal.get(plan, id);
    this.assertPlanAccess(id, grant, current);
    return this.engine(id, grant).review(plan, hash);
  }
  hasAccess(grant: Grant): boolean {
    return Boolean(grant.scopes?.includes(DEPLOY_SCOPE) && grant.resources?.deployments?.length);
  }
  assertPlanAccess(id: string, grant: Grant, plan: Plan): void {
    if (plan.principal !== id || plan.args.account_id !== grant.account)
      throw new PluginError("access_denied", "This deployment belongs to another connection.");
    this.binding(id, grant, String(plan.args.runner_id), String(plan.args.app));
  }
  descriptors(grant: Grant): Record<string, unknown>[] {
    if (!this.hasAccess(grant)) return [];
    return [...DEPLOYMENT_OPERATIONS.values()]
      .map((op) => ({
        operation: op.id,
        product: op.product,
        summary: op.summary,
        implemented: true,
        policy_enabled: true,
        write: op.write,
        input_schema: inputSchema(op),
        notes: [
          "A paired customer-owned runner performs fixed deployment actions. No SSH keys are stored by this service.",
        ],
      }))
      .concat([
        {
          operation: "deployment.logs",
          product: "Customer-owned VPS runner",
          summary:
            "Request the last 100 app log lines. Returns a request ID; read deployment.job.get for the result.",
          implemented: true,
          policy_enabled: true,
          write: false,
          input_schema: {
            type: "object",
            properties: {
              account_id: { type: "integer", const: grant.account },
              runner_id: { type: "string", format: "uuid" },
              app: { type: "string" },
            },
            required: ["account_id", "runner_id", "app"],
            additionalProperties: false,
          },
          notes: [
            "Logs are requested explicitly, scrubbed using local environment secrets and stored privately for seven days.",
          ],
        },
        {
          operation: "deployment.job.get",
          product: "Customer-owned VPS runner",
          summary: "Inspect a tenant-owned runner request, including requested logs.",
          implemented: true,
          policy_enabled: true,
          write: false,
          input_schema: {
            type: "object",
            properties: { request_id: { type: "string", format: "uuid" } },
            required: ["request_id"],
            additionalProperties: false,
          },
          notes: ["Only this connection's requests are returned."],
        },
        {
          operation: "deployment.runner.health",
          product: "Customer-owned VPS runner",
          summary:
            "Read the paired server's latest CPU, load, memory, uptime and consented app health report.",
          implemented: true,
          policy_enabled: true,
          write: false,
          input_schema: {
            type: "object",
            properties: { runner_id: { type: "string", format: "uuid" } },
            required: ["runner_id"],
            additionalProperties: false,
          },
          notes: ["A signed report is a snapshot; check its timestamp."],
        },
      ]);
  }
  private binding(
    id: string,
    grant: Grant,
    runnerId: string,
    app: string,
  ): { runner: Runner; definition: AppDefinition } {
    this.journal.assertLease();
    const live = this.store.get<Grant>("grant", id),
      runner = this.store.get<Runner>("runner", runnerId);
    if (
      !live ||
      live.owner !== grant.owner ||
      !live.scopes?.includes(DEPLOY_SCOPE) ||
      !live.resources?.deployments?.some((r) => r.runner === runnerId && r.app === app) ||
      !runner?.active ||
      runner.owner !== grant.owner ||
      runner.account !== grant.account
    )
      throw new PluginError(
        "access_denied",
        "Pair and approve this app in the consenting browser before deployment.",
      );
    const definition = runner.apps.find((a) => a.name === app);
    if (!definition)
      throw new PluginError("resource_not_found", "This app is not configured on the runner.");
    return { runner, definition };
  }
  private engine(id: string, grant: Grant): Engine {
    const principal: Principal = {
      id,
      accounts: [grant.account],
      credential_env: "HOSTED_PROVIDER_TOKEN",
      operations: [...DEPLOYMENT_OPERATIONS.keys()],
      writes: "enabled",
      resources: {
        zones: {},
        dns_names: {},
        mail_hostings: {},
        mailboxes: {},
        vps: Object.fromEntries(
          (grant.resources?.deployments ?? []).map((r) => [
            r.runner + ":" + r.app,
            { account_id: grant.account, writable: true, disposable: false },
          ]),
        ),
      },
    };
    const api: Api = {
      request: async (method, path, body, _signal, context) => {
        const match = /^\/runner\/([a-f0-9-]{36})\/apps\/([a-z][a-z0-9-]{0,39})$/.exec(path);
        if (!match) throw new PluginError("operation_denied", "Unknown runner route.");
        const { runner, definition } = this.binding(id, grant, match[1]!, match[2]!);
        if (method === "GET") {
          if (this.store.now() - runner.seen > 60_000 || !runner.report?.apps[definition.name])
            throw new PluginError(
              "runner_offline",
              "Start the customer-owned runner and wait for its next health report.",
            );
          const state = runner.report.apps[definition.name]!;
          const job = context?.planId
            ? this.store.get<QueuedJob>("runner-job", context.planId)
            : undefined;
          return {
            revision: state.revision,
            previous_revision: state.previous_revision,
            healthy: state.healthy,
            uncertain: state.uncertain,
            definition,
            runner_identity: fingerprint(runner.publicKey),
            health_scope: state.health_scope,
            ...(context?.planId
              ? {
                  job_verified:
                    job?.state === "finished" &&
                    job.job.plan === context.planId &&
                    job.job.runner === runner.id &&
                    job.job.app === definition.name &&
                    job.job.revision === state.revision &&
                    job.result?.state === "verified" &&
                    job.result.code === "ok",
                }
              : {}),
          };
        }
        if (method !== "POST" || !context?.planId)
          throw new PluginError(
            "approval_required",
            "Deployment requires an independently approved plan.",
          );
        const plan = this.journal.get(context.planId, id);
        if (plan.state !== "executing")
          throw new PluginError("approval_required", "The exact plan must be executing.");
        const action = z.enum(["deploy", "rollback"]).parse(body?.action),
          job = Job.parse({
            id: context.planId,
            runner: runner.id,
            app: definition.name,
            definition,
            action,
            revision: body?.revision,
            expires: plan.expires_at,
            plan: plan.id,
          });
        this.store.atomic(() => {
          if (this.store.get("runner-job", job.id))
            throw new PluginError(
              "invalid_state",
              "This deployment was already queued; inspect it instead of retrying.",
            );
          this.store.put(
            "runner-job",
            job.id,
            { job, grant: id, owner: grant.owner, state: "queued" } satisfies QueuedJob,
            Number.MAX_SAFE_INTEGER,
          );
        });
        return { queued: true };
      },
    };
    return new Engine(
      this.journal,
      principal,
      api,
      [grant.token],
      undefined,
      DEPLOYMENT_OPERATIONS,
    );
  }
  async dispatch(
    id: string,
    grant: Grant,
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!this.hasAccess(grant))
      throw new PluginError(
        "runner_required",
        "Open /runners in the consenting browser to pair a customer-owned runner and select its app.",
      );
    const request =
        name === "infomaniak_read" || name === "infomaniak_plan"
          ? z
              .object({
                operation: z.string().max(120),
                arguments: z.record(z.string(), z.unknown()),
              })
              .strict()
              .parse(input)
          : object(input),
      args = request.arguments === undefined ? {} : object(request.arguments);
    if (name === "infomaniak_read" && request.operation === "deployment.job.get") {
      z.object({ request_id: z.string().uuid() }).strict().parse(args);
      const job = this.store.get<QueuedJob>("runner-job", z.string().uuid().parse(args.request_id));
      if (!job || job.grant !== id || job.owner !== grant.owner)
        throw new PluginError(
          "access_denied",
          "This runner request is unavailable to this connection.",
        );
      this.binding(id, grant, job.job.runner, job.job.app);
      return {
        operation: request.operation,
        data: {
          request_id: job.job.id,
          state: job.result?.state ?? job.state,
          result: job.result ?? null,
        },
      };
    }
    if (name === "infomaniak_read" && request.operation === "deployment.runner.health") {
      z.object({ runner_id: z.string().uuid() }).strict().parse(args);
      const runner = z.string().uuid().parse(args.runner_id),
        first = grant.resources?.deployments?.find((r) => r.runner === runner);
      if (!first)
        throw new PluginError("access_denied", "This runner is not granted to the connection.");
      const { runner: stored } = this.binding(id, grant, runner, first.app);
      return {
        operation: request.operation,
        data: {
          seen_at: stored.seen,
          stale: this.store.now() - stored.seen > 60000,
          host: stored.report?.host ?? null,
          apps: Object.fromEntries(
            Object.entries(stored.report?.apps ?? {}).filter(([app]) =>
              grant.resources?.deployments?.some((r) => r.runner === runner && r.app === app),
            ),
          ),
        },
      };
    }
    if (name === "infomaniak_read" && request.operation === "deployment.logs") {
      z.object({
        account_id: z.number().int().positive(),
        runner_id: z.string().uuid(),
        app: z.string().max(40),
      })
        .strict()
        .parse(args);
      const runner = z.string().uuid().parse(args.runner_id),
        app = z.string().parse(args.app),
        { definition } = this.binding(id, grant, runner, app);
      if (args.account_id !== grant.account)
        throw new PluginError("access_denied", "Choose the consented account.");
      if (
        this.store
          .list<QueuedJob>("runner-job")
          .filter(
            (r) =>
              r.value.grant === id &&
              r.value.state !== "finished" &&
              r.value.job.expires > this.store.now(),
          ).length >= 5
      )
        throw new PluginError(
          "too_many_requests",
          "Wait for the current runner requests before requesting more logs.",
        );
      const job = Job.parse({
        id: randomUUID(),
        runner,
        app,
        action: "logs",
        definition,
        expires: this.store.now() + 120000,
      });
      this.store.put(
        "runner-job",
        job.id,
        { job, grant: id, owner: grant.owner, state: "queued" } satisfies QueuedJob,
        this.store.now() + 7 * 86400000,
      );
      return {
        operation: request.operation,
        data: { request_id: job.id, state: "queued", next_operation: "deployment.job.get" },
      };
    }
    const engine = this.engine(id, grant);
    if (name === "infomaniak_plan" || name === "infomaniak_read") {
      const a = z
        .object({ operation: z.string().max(120), arguments: z.record(z.string(), z.unknown()) })
        .strict()
        .parse(input);
      if (name === "infomaniak_read") return engine.read(a.operation, a.arguments);
      return { plan: await engine.plan(a.operation, a.arguments), approval_required: true };
    }
    const a = z
      .object({
        plan_id: z.string().uuid(),
        plan_hash: z.string().optional(),
        refresh: z.boolean().optional(),
      })
      .strict()
      .parse(input);
    const plan = this.journal.get(a.plan_id, id);
    if (!DEPLOYMENT_OPERATIONS.has(plan.operation))
      throw new PluginError("operation_denied", "This is not a deployment plan.");
    if (name === "infomaniak_execute")
      return {
        plan: await engine.execute(
          plan.id,
          z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(a.plan_hash),
          signal,
        ),
      };
    if (name === "infomaniak_cancel") return { plan: engine.cancel(plan.id) };
    if (name === "infomaniak_operation")
      return {
        plan: a.refresh ? await engine.reconcile(plan.id) : engine.status(plan.id),
        runner_job: this.store.get<QueuedJob>("runner-job", plan.id)?.result ?? null,
      };
    throw new PluginError("operation_denied", "Unknown deployment action.");
  }
  mount(
    app: Express,
    context: {
      origin: URL;
      manageCookie: string;
      cookie: (req: Request, name: string) => string;
      csrf: (req: Request, value: string) => void;
      page: (title: string, body: string) => string;
    },
  ): void {
    const { origin, manageCookie, cookie, csrf, page } = context;
    const session = (req: Request) => {
      const owner = fingerprint(cookie(req, manageCookie)),
        browser = this.store.get<Browser>("browser", owner);
      if (!browser)
        throw new PluginError(
          "connection_expired",
          "Connect your AI in this browser before pairing a runner.",
        );
      return { owner, browser };
    };
    app.post("/runner-api/register", (req, res) => {
      this.store.prune();
      if (this.store.list("runner-pair").length >= 1000)
        throw new PluginError("too_many_requests", "Try pairing later.");
      const input = z
        .object({ publicKey: z.string().max(300), apps: z.array(AppDefinition).min(1).max(10) })
        .strict()
        .parse(req.body);
      try {
        if (createPublicKey(input.publicKey).asymmetricKeyType !== "ed25519") throw new Error();
      } catch {
        throw new PluginError("invalid_input", "Use an Ed25519 runner identity.");
      }
      if (
        new Set(input.apps.map((a) => a.name)).size !== input.apps.length ||
        new Set(input.apps.map((a) => a.hostname)).size !== input.apps.length
      )
        throw new PluginError("invalid_input", "Each runner app and hostname must be unique.");
      const id = opaque(),
        expires = this.store.now() + 600000;
      this.store.put("runner-pair", fingerprint(id), { ...input, expires } satisfies Pair, expires);
      res
        .status(201)
        .json({ pairing_url: new URL("/runners/pair/" + id, origin).href, request: id, expires });
    });
    app.post("/runner-api/pair-status", (req, res) => {
      const a = z
          .object({ request: z.string().max(100), signature: z.string().max(150) })
          .strict()
          .parse(req.body),
        p = this.store.get<Pair>("runner-pair", fingerprint(a.request));
      if (!p || !validSignature({ request: a.request }, a.signature, p.publicKey))
        throw new PluginError("access_denied", "Pairing expired or runner identity is invalid.");
      if (!p.runner) {
        res.json({ pending: true });
        return;
      }
      const runner = this.store.get<Runner>("runner", p.runner);
      if (!runner?.active) throw new PluginError("access_denied", "Pairing was revoked.");
      // Keep the signed response recoverable until the original pairing expiry.
      // A lost HTTP response must not strand an already paired local identity.
      res.json({ runner: runner.id, publicKey: this.keys.publicKey });
    });
    app.get("/runners/pair/:id", (req, res) => {
      const { owner, browser } = session(req),
        id = String(req.params.id),
        p = this.store.get<Pair>("runner-pair", fingerprint(id));
      if (!p || p.runner)
        throw new PluginError("connection_expired", "Start pairing again from the runner.");
      const grants = this.store
        .list<Grant>("grant")
        .filter(
          (r) =>
            r.value.owner === owner &&
            r.value.scopes?.includes(DEPLOY_SCOPE) &&
            r.value.resources?.deploymentEnrollment,
        );
      res
        .type("html")
        .send(
          page(
            "Pair your deployment runner",
            `<h1>Pair this runner.</h1><p class="lead">It can build and release only the apps listed here. Repository code runs on your server.</p>${p.apps.map((a) => `<section class="panel"><h2>${e(a.name)}</h2><p>${e(a.hostname)}</p><code>${e(a.repository)}</code></section>`).join("")}<form method="post"><input type="hidden" name="csrf" value="${e(browser.csrf)}"><label>Connection<select name="connection" required><option value="">Choose the AI connection</option>${grants.map((g) => `<option value="${e(g.id)}">Account ${g.value.account} · ${e(this.store.get<{ client_name?: string }>("client", g.value.client)?.client_name ?? "AI app")}</option>`).join("")}</select></label><button>Pair and allow these apps</button></form><small>If no connection is listed, reconnect your AI with deployment enrollment enabled.</small>`,
          ),
        );
    });
    app.post("/runners/pair/:id", (req, res) => {
      const { owner, browser } = session(req);
      csrf(req, browser.csrf);
      const id = String(req.params.id),
        p = this.store.get<Pair>("runner-pair", fingerprint(id)),
        connection = z.string().uuid().parse(req.body.connection),
        g = this.store.get<Grant>("grant", connection);
      if (
        !p ||
        p.runner ||
        !g ||
        g.owner !== owner ||
        !g.scopes?.includes(DEPLOY_SCOPE) ||
        !g.resources?.deploymentEnrollment
      )
        throw new PluginError("access_denied", "This connection cannot pair the requested runner.");
      if (
        this.store.list<Runner>("runner").filter((r) => r.value.owner === owner && r.value.active)
          .length >= 10
      )
        throw new PluginError(
          "too_many_requests",
          "Revoke an unused runner before adding another.",
        );
      this.store.atomic(() => {
        const pair = this.store.get<Pair>("runner-pair", fingerprint(id)),
          grant = this.store.get<Grant>("grant", connection);
        if (
          !pair ||
          pair.runner ||
          !grant ||
          grant.owner !== owner ||
          !grant.scopes?.includes(DEPLOY_SCOPE) ||
          !grant.resources?.deploymentEnrollment ||
          this.store.list<Runner>("runner").filter((r) => r.value.owner === owner && r.value.active)
            .length >= 10
        )
          throw new PluginError("access_denied", "Pairing or connection permission changed.");
        const runner: Runner = {
          id: randomUUID(),
          owner,
          account: grant.account,
          publicKey: pair.publicKey,
          apps: pair.apps,
          active: true,
          sequence: 0,
          seen: 0,
        };
        this.store.put("runner", runner.id, runner, Number.MAX_SAFE_INTEGER);
        pair.runner = runner.id;
        this.store.put("runner-pair", fingerprint(id), pair, pair.expires);
        grant.resources ??= { zones: [], mailboxes: [] };
        grant.resources.deployments ??= [];
        grant.resources.deployments.push(
          ...runner.apps.map((a) => ({ runner: runner.id, app: a.name })),
        );
        this.store.put("grant", connection, grant, grant.expires);
      });
      res.redirect(303, "/runners");
    });
    app.get("/runners", (req, res) => {
      const { owner, browser } = session(req),
        runners = this.store
          .list<Runner>("runner")
          .filter((r) => r.value.owner === owner && r.value.active);
      res
        .type("html")
        .send(
          page(
            "Deployment runners",
            `<a href="/operations">← Operations</a><h1>Your runners.</h1><p class="lead">Server-owned identities. SSH keys and app environment files stay on the VPS.</p><p>Install the runner on your VPS, configure its allowed repository and app hostname, then run its pairing command. Review the link in this browser.</p><code>infomaniak-ai runner --help</code>${runners.map(({ id, value: r }) => `<section class="panel"><h2>${e(r.apps.map((a) => a.name).join(", "))}</h2><p>${r.seen && this.store.now() - r.seen < 60000 ? "Online" : "Waiting for runner"}</p><code>${e(JSON.stringify({ runner_id: id, apps: r.report?.apps ?? {}, configuration: r.apps }, null, 2))}</code><form action="/runners/${e(id)}/revoke" method="post"><input type="hidden" name="csrf" value="${e(browser.csrf)}"><button>Revoke runner access</button></form></section>`).join("") || "<p>No paired runners yet.</p>"}`,
          ),
        );
    });
    app.post("/runners/:id/revoke", (req, res) => {
      const { owner, browser } = session(req);
      csrf(req, browser.csrf);
      const r = this.store.get<Runner>("runner", String(req.params.id));
      if (!r || r.owner !== owner) throw new PluginError("access_denied", "Runner unavailable.");
      r.active = false;
      this.store.put(
        "runner",
        r.id,
        r,
        this.awaitingCompletion(r.id) ? Number.MAX_SAFE_INTEGER : this.store.now() + 7 * 86400000,
      );
      res.redirect(303, "/runners");
    });
    app.post("/runner-api/poll", (req, res) => {
      const a = z
          .object({
            runner: z.string().uuid(),
            sequence: z.number().int().positive().safe(),
            report: Report,
            signature: z.string().max(150),
          })
          .strict()
          .parse(req.body),
        { signature, ...payload } = req.body as Record<string, unknown>;
      let runner = this.store.get<Runner>("runner", a.runner);
      if (
        !runner ||
        !validSignature(payload, String(signature), runner.publicKey) ||
        a.sequence <= runner.sequence
      )
        throw new PluginError(
          "access_denied",
          "Runner signature, sequence or permission is invalid.",
        );
      // Consent gates new work below. Already-issued work keeps a signed
      // completion path after disconnect or connection expiry.
      if (Object.keys(a.report.apps).some((name) => !runner!.apps.some((app) => app.name === name)))
        throw new PluginError("access_denied", "The report includes an unpaired app.");
      const discarded: string[] = [];
      for (const result of a.report.results) {
        const saved = this.store.get<QueuedJob>("runner-job", result.id);
        if (!saved) {
          // Expired history must not wedge a runner retrying a lost acknowledgement.
          // Discard the unprovable result without certifying any plan or retaining logs.
          discarded.push(result.id);
          continue;
        }
        if (saved.job.runner !== runner.id || saved.job.app !== result.app)
          throw new PluginError("access_denied", "The result is outside this runner.");
        if (
          saved.job.action !== "logs" &&
          (result.logs !== undefined ||
            result.code === "logs" ||
            (result.state === "verified" && result.code !== "ok"))
        )
          throw new PluginError(
            "invalid_response",
            "A deployment result has an invalid result code or log payload.",
          );
        if (saved.job.action === "logs" && (result.state !== "verified" || result.code !== "logs"))
          throw new PluginError("invalid_response", "Unexpected log result.");
      }
      const completionOnly =
        a.report.results.length > 0 &&
        a.report.results.every((result) => {
          const saved = this.store.get<QueuedJob>("runner-job", result.id);
          return saved && saved.state !== "queued" && saved.job.action !== "logs";
        });
      if (!runner.active && !completionOnly)
        throw new PluginError(
          "access_denied",
          "A revoked runner may only finish its already-issued deployments.",
        );
      this.store.atomic(() => {
        const live = this.store.get<Runner>("runner", a.runner);
        if (!live || (!live.active && !completionOnly) || a.sequence <= live.sequence)
          throw new PluginError("access_denied", "Runner request was replayed.");
        live.sequence = a.sequence;
        // Results belong only to expiring job records, never the runner identity.
        live.report = live.active
          ? { ...a.report, results: [] }
          : { version: 1, apps: a.report.apps, results: [] };
        live.seen = this.store.now();
        const completed = a.report.results.filter((r) => r.state !== "unknown").map((r) => r.id);
        this.store.put(
          "runner",
          live.id,
          live,
          live.active || this.awaitingCompletion(live.id, completed)
            ? Number.MAX_SAFE_INTEGER
            : this.store.now() + 7 * 86400000,
        );
        runner = live;
      });
      for (const result of a.report.results.filter((r) => !discarded.includes(r.id))) {
        const saved = this.store.get<QueuedJob>("runner-job", result.id)!,
          p = saved.job.plan && this.store.get<Plan>("write-plan", saved.job.plan);
        if (!saved.result || saved.result.state === "unknown") {
          saved.state = "finished";
          saved.result = result;
          const unresolved = p && ["executing", "pending", "unknown"].includes(p.state);
          this.store.put(
            "runner-job",
            result.id,
            saved,
            unresolved ? Number.MAX_SAFE_INTEGER : this.store.now() + 7 * 86400000,
          );
        }
        const state = a.report.apps[result.app];
        if (
          p &&
          ["pending", "unknown"].includes(p.state) &&
          result.state === "verified" &&
          saved.job.action !== "logs" &&
          state &&
          !state.uncertain &&
          (!state.healthy || state.revision !== saved.job.revision)
        )
          this.journal.transition(p.id, p.principal, ["pending", "unknown"], "failed", {
            outcome:
              "The runner completed this job, but the latest signed app state is not the requested healthy release. Inspect the current app and prepare a separate recovery plan.",
          });
        if (
          p &&
          ["pending", "unknown"].includes(p.state) &&
          result.state === "failed" &&
          state &&
          !state.uncertain &&
          state.revision === object(p.change.before).revision
        )
          this.journal.transition(p.id, p.principal, ["pending", "unknown"], "failed", {
            outcome:
              "Runner failed with " +
              result.code +
              "; its prior release state is restored. Inspect the app before a fresh plan.",
          });
      }
      const jobs = this.store
        .list<QueuedJob>("runner-job")
        .map((r) => r.value)
        .filter(
          (r) =>
            r.job.runner === a.runner && r.state !== "finished" && r.job.expires > this.store.now(),
        );
      const deliver: Job[] = [];
      for (const queued of jobs) {
        if (!runner.active) break;
        if (queued.job.action !== "logs") {
          const plan = queued.job.plan && this.store.get<Plan>("write-plan", queued.job.plan);
          if (
            !plan ||
            plan.principal !== queued.grant ||
            !["executing", "pending", "unknown"].includes(plan.state)
          ) {
            // Operator abandonment ends future delivery, including after a restart.
            // It cannot recall a job that the runner has already received.
            queued.state = "finished";
            this.store.put("runner-job", queued.job.id, queued, this.store.now() + 7 * 86400000);
            continue;
          }
        }
        const g = this.store.get<Grant>("grant", queued.grant);
        if (!g) continue;
        try {
          this.binding(queued.grant, g, a.runner, queued.job.app);
        } catch {
          continue;
        }
        deliver.push(queued.job);
        queued.state = "sent";
        this.store.put(
          "runner-job",
          queued.job.id,
          queued,
          queued.job.action === "logs" ? this.store.now() + 7 * 86400000 : Number.MAX_SAFE_INTEGER,
        );
        break;
      }
      res.json({
        jobs: deliver.map((job) => ({ job, signature: signed(job, this.keys.privateKey) })),
        acknowledged: a.report.results.map((r) => r.id),
        ...(discarded.length ? { discarded } : {}),
      });
    });
  }
}
