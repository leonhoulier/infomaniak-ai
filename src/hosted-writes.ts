import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HostedStore, fingerprint } from "./hosted-store.js";
import { WRITE_SCOPE, type Grant } from "./hosted-oauth.js";
import { Engine } from "./engine.js";
import type { Plan, State } from "./journal.js";
import type { Principal } from "./access.js";
import { PluginError } from "./errors.js";
import {
  canonical,
  OPERATIONS,
  inputSchema,
  requireOperation,
  txtData,
  dnsTargetValue,
} from "./registry.js";
import { ApiError, list, object, type Api } from "./provider.js";
import { DNS_SCOPE, MAIL_SCOPE, verifyMailbox } from "./hosted-resources.js";

export { WRITE_SCOPE } from "./hosted-oauth.js";
export const TEST_NAME = "_infomaniak-ai-test";
export const DNS_WRITES = ["dns.record.create", "dns.record.update", "dns.record.delete"] as const;
const terminal = new Set<State>(["verified", "failed", "stale", "cancelled"]);
const invalid = () =>
  new PluginError(
    "access_denied",
    "Disposable DNS writes require separate consent for a verified domain in this account.",
  );

/** Operator-only escape hatch after manual provider inspection; never an MCP tool. */
export function abandonHostedPlan(store: HostedStore, id: string, reason: string): void {
  z.string().uuid().parse(id);
  z.string().trim().min(20).max(500).parse(reason);
  store.atomic(() => {
    if (store.get("write-runtime", "lease"))
      throw new PluginError(
        "state_in_use",
        "Stop the gateway and wait for its writer lease to expire before operator recovery.",
      );
    const p = store.get<Plan>("write-plan", id);
    if (!p || !["executing", "pending", "unknown"].includes(p.state))
      throw new PluginError(
        "invalid_state",
        "Only interrupted, pending or unknown operations can be explicitly abandoned.",
      );
    const job = store.get<{ state: string; result?: { state: string } }>("runner-job", id);
    if (
      p.operation.startsWith("deployment.") &&
      job &&
      job.state !== "queued" &&
      (!job.result || job.result.state === "unknown")
    )
      throw new PluginError(
        "runner_job_in_flight",
        "This runner already received the job and has no confirmed terminal result. Keep its lock; recover the runner and obtain its signed completion before abandoning.",
      );
    const key = fingerprint(p.change.resource),
      lock = store.get<{ plan: string }>("write-lock", key);
    if (lock && lock.plan !== id)
      throw new PluginError("resource_busy", "A different operation owns this resource lock.");
    if (job)
      store.put(
        "runner-job",
        id,
        { ...job, state: job.state === "queued" ? "finished" : job.state },
        store.now() + 7 * 86400000,
      );
    store.put(
      "write-plan",
      id,
      {
        ...p,
        state: "stale",
        updated_at: store.now(),
        outcome:
          "Operator abandoned an UNVERIFIED write after manual inspection: " +
          reason +
          ". This is not proof of failure or success; inspect provider state before preparing another change.",
      },
      store.now() + 7 * 86400000,
    );
    if (lock) store.delete("write-lock", key);
  });
}

/** No plan values or resource names are written outside the encrypted hosted vault. */
export class HostedWriteJournal {
  private lockId = randomUUID();
  private heartbeat: ReturnType<typeof setInterval>;
  constructor(private store: HostedStore) {
    store.atomic(() => {
      if (store.get("write-runtime", "lease"))
        throw new PluginError(
          "state_in_use",
          "Another write runtime owns this vault. After a crash, wait 30 seconds before restarting.",
        );
      store.put("write-runtime", "lease", { id: this.lockId }, store.now() + 30_000);
    });
    this.heartbeat = setInterval(() => {
      try {
        store.atomic(() => {
          this.assertLease();
          store.put("write-runtime", "lease", { id: this.lockId }, store.now() + 30_000);
        });
      } catch {
        /* Lost lease fails closed on the next operation. */
      }
    }, 10_000);
    this.heartbeat.unref();
    try {
      for (const { value } of store.list<Plan>("write-plan")) {
        if (["executing", "pending", "unknown"].includes(value.state)) {
          const job = store.get<unknown>("runner-job", value.id);
          if (job) store.put("runner-job", value.id, job, Number.MAX_SAFE_INTEGER);
        }
        if (value.state === "executing")
          this.transition(value.id, value.principal, ["executing"], "unknown", {
            outcome: "Gateway restarted during execution. Readback is required; do not resend.",
          });
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }
  assertLease(): void {
    if (this.store.get<{ id: string }>("write-runtime", "lease")?.id !== this.lockId)
      throw new PluginError(
        "state_in_use",
        "This write runtime lost its lease. No mutation may start.",
      );
  }
  list(principal: string): Plan[] {
    return this.store
      .list<Plan>("write-plan")
      .map((r) => r.value)
      .filter((p) => p.principal === principal);
  }
  get(id: string, principal: string): Plan {
    this.assertLease();
    const p = this.store.get<Plan>("write-plan", id);
    if (!p || p.principal !== principal)
      throw new PluginError(
        "plan_not_found",
        "No operation with this ID belongs to this connection.",
      );
    return p;
  }
  private save(p: Plan): void {
    const expires = ["executing", "pending", "unknown"].includes(p.state)
      ? Number.MAX_SAFE_INTEGER
      : this.store.now() + 7 * 86_400_000;
    this.store.put("write-plan", p.id, p, expires);
  }
  create(p: Plan): Plan {
    return this.store.atomic(() => {
      this.assertLease();
      const all = this.store.list<Plan>("write-plan");
      const active = all.filter(
        (r) =>
          !terminal.has(r.value.state) &&
          (["executing", "pending", "unknown"].includes(r.value.state) ||
            r.value.expires_at > this.store.now()),
      );
      if (
        active.length >= 2000 ||
        active.filter((r) => r.value.principal === p.principal).length >= 20 ||
        active.filter((r) => r.value.args.account_id === p.args.account_id).length >= 100
      )
        throw new PluginError(
          "plan_limit",
          "Cancel an existing plan or ask the operator to reconcile old operations.",
        );
      // Completed history must not consume other customers' active-plan capacity.
      // Keep bounded history for at most seven days; uncertain operations never evict.
      const history = all
        .filter(
          (r) =>
            terminal.has(r.value.state) ||
            (["planned", "approved"].includes(r.value.state) &&
              r.value.expires_at <= this.store.now()),
        )
        .sort((a, b) => a.value.updated_at - b.value.updated_at);
      let total = all.length,
        own = all.filter((r) => r.value.principal === p.principal).length;
      for (const row of history) {
        if (total < 20000 && (own < 200 || row.value.principal !== p.principal)) continue;
        this.store.delete("write-plan", row.id);
        total--;
        if (row.value.principal === p.principal) own--;
      }
      if (this.store.get("write-plan", p.id))
        throw new PluginError("invalid_state", "Plan already exists.");
      this.save(p);
      return p;
    });
  }
  transition(
    id: string,
    principal: string,
    from: State[],
    state: State,
    patch: Partial<Pick<Plan, "approved_at" | "outcome">> = {},
    lock?: string,
  ): Plan {
    return this.store.atomic(() => {
      const p = this.get(id, principal);
      if (!from.includes(p.state))
        throw new PluginError(
          "invalid_state",
          "Inspect the current operation state before proceeding.",
        );
      if (lock) {
        const key = fingerprint(lock);
        if (this.store.get("write-lock", key))
          throw new PluginError("resource_busy", "An unreconciled write holds this resource.");
        this.store.put("write-lock", key, { plan: id }, Number.MAX_SAFE_INTEGER);
      }
      const next = { ...p, ...patch, state, updated_at: Date.now() };
      this.save(next);
      if (terminal.has(state)) {
        const job = this.store.get<unknown>("runner-job", id);
        if (job) this.store.put("runner-job", id, job, this.store.now() + 7 * 86400000);
      }
      if (
        terminal.has(state) &&
        this.store.get<{ plan: string }>("write-lock", fingerprint(p.change.resource))?.plan === id
      )
        this.store.delete("write-lock", fingerprint(p.change.resource));
      return next;
    });
  }
  approve(id: string, principal: string, hash: string): Plan {
    const p = this.get(id, principal);
    if (p.hash !== hash) throw new PluginError("plan_mismatch", "The exact reviewed plan changed.");
    if (p.expires_at <= Date.now())
      throw new PluginError("plan_expired", "Create a fresh plan from current state.");
    return this.transition(id, principal, ["planned"], "approved", { approved_at: Date.now() });
  }
  close(): void {
    clearInterval(this.heartbeat);
    this.store.atomic(() => {
      if (this.store.get<{ id: string }>("write-runtime", "lease")?.id === this.lockId)
        this.store.delete("write-runtime", "lease");
    });
  }
}

export async function verifyWriteZone(api: Api, account: number, zone: string): Promise<void> {
  const rows = list(
    await api.request(
      "GET",
      "/1/products?account_id=" + account + "&service_name=domain&per_page=1000",
    ),
  );
  if (
    !rows.some((v) => {
      const p = object(v);
      return p.account_id === account && p.service_name === "domain" && p.customer_name === zone;
    })
  )
    throw invalid();
}
export class HostedWrites {
  readonly journal: HostedWriteJournal;
  constructor(
    private store: HostedStore,
    private api: (token: string, guard: () => void) => Api,
  ) {
    this.journal = new HostedWriteJournal(store);
  }
  hasAccess(grant: Grant): boolean {
    return Boolean(
      (grant.writeZone && grant.scopes?.includes(WRITE_SCOPE)) ||
      (grant.resources?.zones.length && grant.scopes?.includes(DNS_SCOPE)) ||
      (grant.resources?.mailboxes.length && grant.scopes?.includes(MAIL_SCOPE)),
    );
  }
  principal(id: string, grant: Grant): Principal {
    if (!this.hasAccess(grant)) throw invalid();
    const binding = { account_id: grant.account, disposable: false, writable: true };
    const zones = grant.scopes?.includes(DNS_SCOPE) ? (grant.resources?.zones ?? []) : [];
    const mailboxes = grant.scopes?.includes(MAIL_SCOPE) ? (grant.resources?.mailboxes ?? []) : [];
    const legacy = Boolean(grant.writeZone && grant.scopes?.includes(WRITE_SCOPE));
    return {
      id,
      credential_env: "HOSTED_PROVIDER_TOKEN",
      accounts: [grant.account],
      operations: [
        ...new Set([
          ...(legacy || zones.length ? DNS_WRITES : []),
          ...(zones.length
            ? ["dns.records.list", "dns.audit", "dns.propagation", "domains.expiry"]
            : []),
          ...(mailboxes.length
            ? [
                "mail.mailbox.get",
                "mail.aliases.list",
                "mail.forwarding.get",
                "mail.alias.add",
                "mail.alias.delete",
                "mail.forwarding.add",
                "mail.forwarding.delete",
                "mail.forwarding.update",
              ]
            : []),
        ]),
      ],
      writes: zones.length || mailboxes.length ? "enabled" : "disposable-only",
      resources: {
        zones: Object.fromEntries(zones.map((zone) => [zone, binding])),
        dns_names: legacy
          ? { [grant.writeZone + ":" + TEST_NAME]: { ...binding, disposable: true } }
          : {},
        mail_hostings: {},
        mailboxes: Object.fromEntries(mailboxes.map((m) => [m.hosting + ":" + m.name, binding])),
        vps: {},
      },
    };
  }
  descriptors(grant: Grant): Record<string, unknown>[] {
    const principal = this.principal("descriptor", grant);
    return principal.operations.map((id) => {
      const op = requireOperation(id),
        schema = inputSchema(op),
        properties = object(schema.properties);
      for (const [key, value] of Object.entries({
        account_id: grant.account,
        ...(!grant.resources?.zones.length
          ? { zone: grant.writeZone, source: TEST_NAME, expected_source: TEST_NAME, type: "TXT" }
          : {}),
      }))
        if (value !== undefined && Object.hasOwn(properties, key))
          properties[key] = { ...object(properties[key]), const: value };
      if (properties.zone && grant.resources?.zones.length)
        properties.zone = { ...object(properties.zone), enum: grant.resources.zones };
      return {
        operation: id,
        summary: op.summary,
        implemented: true,
        policy_enabled: true,
        write: op.write,
        input_schema: { ...schema, properties },
        notes: [
          ...(op.notes ?? []),
          "Only consented resources in this account. Every write needs independent browser approval.",
        ],
        live_verified: false,
      };
    });
  }
  status(grant: Grant): Record<string, unknown> {
    const descriptors = this.hasAccess(grant) ? this.descriptors(grant) : [];
    return {
      writes_enabled: this.hasAccess(grant),
      mode: grant.resources ? "hosted-resources" : "hosted-scoped-dns-beta",
      available_writes: descriptors.filter((d) => d.write).map((d) => d.operation),
      available_resource_reads: descriptors.filter((d) => !d.write).map((d) => d.operation),
      resources: grant.resources ?? null,
      ...(grant.writeZone
        ? {
            write_scope: WRITE_SCOPE,
            write_zone: grant.writeZone,
            write_source: TEST_NAME,
            write_type: "TXT",
          }
        : {}),
      next_step:
        "Resolve names with resources.resolve, inspect the matching resource, then prepare an exact plan. Open approval_url for the user's review before execution.",
    };
  }
  async recovery(id: string, grant: Grant, original: Plan): Promise<Plan> {
    if (original.principal !== id || original.state !== "verified") throw invalid();
    const engine = this.engine(id, grant),
      a = original.args;
    if (original.operation.startsWith("mail.alias."))
      return engine.plan(
        original.operation === "mail.alias.add" ? "mail.alias.delete" : "mail.alias.add",
        a,
      );
    if (!original.operation.startsWith("dns.record."))
      throw new PluginError(
        "operation_denied",
        "Use the recorded recovery instructions for this operation.",
      );
    if (!grant.scopes?.includes(DNS_SCOPE) || !grant.resources?.zones.includes(String(a.zone)))
      throw new PluginError(
        "operation_denied",
        "DNS recovery requires active full-domain consent. Legacy test connections can prepare a separate inverse plan manually.",
      );
    const before = list(original.change.before).map(object);
    if (original.operation === "dns.record.create") {
      const live = list(
        (await engine.read("dns.records.list", { account_id: grant.account, zone: a.zone })).data,
      ).map(object);
      const target = (value: unknown) =>
        typeof a.type === "string" && typeof value === "string"
          ? dnsTargetValue(a.type, value)
          : value;
      const found = live.filter(
        (r) =>
          !before.some((b) => b.id === r.id) &&
          r.source === a.source &&
          r.type === a.type &&
          target(r.target) === target(a.target),
      );
      if (found.length !== 1)
        throw new PluginError(
          "ambiguous_resource",
          "The created record is no longer uniquely identifiable. Inspect DNS before recovery.",
        );
      return engine.plan("dns.record.delete", {
        account_id: grant.account,
        zone: a.zone,
        record_id: found[0]!.id,
        expected_source: a.source,
      });
    }
    const record = before.find((r) => r.id === a.record_id);
    if (!record)
      throw new PluginError(
        "invalid_state",
        "The original record is absent from the retained plan.",
      );
    return engine.plan(
      original.operation === "dns.record.delete" ? "dns.record.create" : "dns.record.update",
      {
        account_id: grant.account,
        zone: a.zone,
        ...(original.operation === "dns.record.delete"
          ? { source: record.source, type: record.type }
          : { record_id: a.record_id, expected_source: record.source }),
        target:
          record.type === "TXT" && typeof record.target === "string"
            ? txtData(record.target)
            : record.target,
        ttl: record.ttl,
      },
    );
  }
  private engine(id: string, grant: Grant): Engine {
    const principal = this.principal(id, grant);
    const active = () => {
      this.journal.assertLease();
      const live = this.store.get<Grant>("grant", id);
      if (
        !live ||
        live.token !== grant.token ||
        live.writeZone !== grant.writeZone ||
        canonical(live.scopes) !== canonical(grant.scopes) ||
        canonical(live.resources) !== canonical(grant.resources)
      )
        throw invalid();
    };
    const provider = this.api(grant.token, active);
    const controlled: Api = {
      request: async (method, path, body, signal) => {
        active();
        const dns = /^\/2\/zones\/([^/]+)\/records(?:\/([0-9]+))?$/.exec(path);
        if (dns) {
          const zone = decodeURIComponent(dns[1]!);
          const full = Boolean(
            grant.scopes?.includes(DNS_SCOPE) && grant.resources?.zones.includes(zone),
          );
          if (!full && !(zone === grant.writeZone && grant.scopes?.includes(WRITE_SCOPE)))
            throw invalid();
          await verifyWriteZone(provider, grant.account, zone);
          active();
          if (signal?.aborted) throw new ApiError(false);
          const result = await provider.request(method, path, body, signal);
          if (
            !full &&
            method === "GET" &&
            list(result).some((v) => {
              const r = object(v);
              return r.source === TEST_NAME && r.type !== "TXT";
            })
          )
            throw new PluginError(
              "protected_record",
              "The test name contains a non-TXT record. No write is permitted.",
            );
          return result;
        }
        const mail =
          /^\/1\/mail_hostings\/([0-9]+)\/mailboxes\/([^/]+)(?:\/(aliases|forwarding_addresses)(?:\/[^/]+)?)?$/.exec(
            path,
          );
        if (mail) {
          const mailbox =
            grant.scopes?.includes(MAIL_SCOPE) &&
            grant.resources?.mailboxes.find(
              (m) => m.hosting === Number(mail[1]) && m.name === decodeURIComponent(mail[2]!),
            );
          if (!mailbox) throw invalid();
          await verifyMailbox(provider, grant.account, mailbox);
          active();
          if (signal?.aborted) throw new ApiError(false);
          if (method !== "GET" && !mail[3]) throw invalid();
          return provider.request(method, path, body, signal);
        }
        if (
          method === "GET" &&
          path === "/1/products?account_id=" + grant.account + "&service_name=domain&per_page=1000"
        )
          return provider.request(method, path, body, signal);
        throw invalid();
      },
    };
    return new Engine(this.journal, principal, controlled, [grant.token]);
  }
  review(id: string, grant: Grant, plan: string, hash: string): Plan {
    return this.engine(id, grant).review(plan, hash);
  }
  async dispatch(
    id: string,
    grant: Grant,
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const engine = this.engine(id, grant);
    if (name === "infomaniak_read") {
      const a = z
        .object({ operation: z.string().max(120), arguments: z.record(z.string(), z.unknown()) })
        .strict()
        .parse(input);
      return engine.read(a.operation, a.arguments);
    }
    if (name === "infomaniak_plan") {
      const args = z
        .object({ operation: z.string().max(120), arguments: z.record(z.string(), z.unknown()) })
        .strict()
        .parse(input);
      const a = args.arguments;
      if (
        a.account_id !== grant.account ||
        !this.principal(id, grant).operations.includes(args.operation) ||
        !OPERATIONS.get(args.operation)?.write
      )
        throw invalid();
      const fullDns =
        grant.scopes?.includes(DNS_SCOPE) && grant.resources?.zones.includes(String(a.zone));
      if (
        args.operation.startsWith("dns.") &&
        !fullDns &&
        (a.zone !== grant.writeZone ||
          (a.source ?? a.expected_source) !== TEST_NAME ||
          (args.operation === "dns.record.create" && a.type !== "TXT"))
      )
        throw invalid();
      return { plan: await engine.plan(args.operation, a), approval_required: true };
    }
    if (name === "infomaniak_execute") {
      const a = z
        .object({ plan_id: z.string().uuid(), plan_hash: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(input);
      return { plan: await engine.execute(a.plan_id, a.plan_hash, signal) };
    }
    if (name === "infomaniak_operation") {
      const a = z
        .object({ plan_id: z.string().uuid(), refresh: z.boolean().default(false) })
        .strict()
        .parse(input);
      return { plan: a.refresh ? await engine.reconcile(a.plan_id) : engine.status(a.plan_id) };
    }
    if (name === "infomaniak_cancel") {
      const a = z.object({ plan_id: z.string().uuid() }).strict().parse(input);
      return { plan: engine.cancel(a.plan_id) };
    }
    throw new PluginError("unknown_tool", "This hosted write tool is unavailable.");
  }
}
