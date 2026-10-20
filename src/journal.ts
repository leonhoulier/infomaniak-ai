import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  lstatSync,
  closeSync,
  openSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Args, Change } from "./registry.js";
import { PluginError } from "./errors.js";
export type State =
  | "planned"
  | "approved"
  | "executing"
  | "pending"
  | "verified"
  | "failed"
  | "unknown"
  | "stale"
  | "cancelled";
export interface Plan {
  id: string;
  principal: string;
  operation: string;
  revision: string;
  args: Args;
  change: Change;
  hash: string;
  state: State;
  created_at: number;
  expires_at: number;
  updated_at: number;
  approved_at?: number;
  outcome?: string;
}
const terminal = new Set<State>(["verified", "failed", "stale", "cancelled"]);
const PROCESS_INSTANCE = randomUUID();
/** Local disk is part of the trusted operator boundary; SQLite serializes approvals and execution claims. */
export class Journal {
  private readonly db: DatabaseSync;
  private lockPath: string | undefined;
  private lockId = randomUUID();
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = lstatSync(directory);
    if (
      !dir.isDirectory() ||
      dir.isSymbolicLink() ||
      (process.platform !== "win32" && ((dir.mode & 0o077) !== 0 || dir.uid !== process.getuid?.()))
    )
      throw new PluginError(
        "unsafe_state_directory",
        "Use a private state directory owned by this user (mode 0700).",
      );
    const file = join(directory, "operations.sqlite");
    try {
      closeSync(openSync(file, "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = lstatSync(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
    )
      throw new PluginError(
        "unsafe_state_directory",
        "Operation database must be a private regular file owned by this user.",
      );
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, principal TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS by_principal ON operations(principal);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, plan_id TEXT NOT NULL, principal TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS locks(resource TEXT PRIMARY KEY, plan_id TEXT NOT NULL);
    `);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        chmodSync(file + suffix, 0o600);
      } catch {
        /* Created when needed by SQLite. */
      }
    }
  }
  /** Only one gateway owns a state directory. Administrative approval can use a second DB connection. */
  claimRuntime(): void {
    const path = join(this.directory, "runtime.lock");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, "wx", 0o600);
        writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, id: this.lockId, process_instance: PROCESS_INSTANCE }),
        );
        closeSync(fd);
        this.lockPath = path;
        for (const p of this.all())
          if (p.state === "executing")
            this.transition(p.id, p.principal, ["executing"], "unknown", {
              outcome: "Gateway restarted during execution; readback is required.",
            });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let pid: number, instance: string | undefined;
        try {
          const info = lstatSync(path);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe lock");
          const lock = JSON.parse(readFileSync(path, "utf8"));
          pid = lock.pid;
          instance = lock.process_instance;
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid pid");
        } catch {
          throw new PluginError(
            "state_in_use",
            "Invalid runtime lock. An operator must inspect it before starting.",
          );
        }
        // Containers commonly restart with PID 1. A different process instance
        // with our current PID cannot still be the old live process.
        if (pid === process.pid && instance !== PROCESS_INSTANCE) {
          unlinkSync(path);
          continue;
        }
        try {
          process.kill(pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") {
            unlinkSync(path);
            continue;
          }
        }
        throw new PluginError(
          "state_in_use",
          "Another gateway owns this state directory. Stop it before starting another instance.",
        );
      }
    }
    throw new PluginError("state_in_use", "Could not acquire the runtime lock.");
  }
  private all(): Plan[] {
    return this.db
      .prepare("SELECT data FROM operations")
      .all()
      .map((r) => JSON.parse(String(r.data)) as Plan);
  }
  list(principal: string): Plan[] {
    return this.db
      .prepare("SELECT data FROM operations WHERE principal=? ORDER BY rowid DESC LIMIT 100")
      .all(principal)
      .map((r) => JSON.parse(String(r.data)) as Plan);
  }
  get(id: string, principal: string): Plan {
    const row = this.db
      .prepare("SELECT data FROM operations WHERE id=? AND principal=?")
      .get(id, principal);
    if (!row)
      throw new PluginError(
        "plan_not_found",
        "No operation with this ID belongs to this connection.",
      );
    return JSON.parse(String(row.data)) as Plan;
  }
  create(plan: Plan): Plan {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM operations WHERE principal=? AND state IN ('planned','approved')",
        )
        .get(plan.principal);
      if (Number(row?.count) >= 20)
        throw new PluginError("plan_limit", "Cancel an existing plan before creating another.");
      this.db
        .prepare("INSERT INTO operations(id,principal,state,data) VALUES(?,?,?,?)")
        .run(plan.id, plan.principal, plan.state, JSON.stringify(plan));
      this.event(plan);
      this.db.exec("COMMIT");
      return plan;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private event(plan: Plan): void {
    this.db
      .prepare("INSERT INTO events(plan_id,principal,state,at) VALUES(?,?,?,?)")
      .run(plan.id, plan.principal, plan.state, plan.updated_at);
  }
  transition(
    id: string,
    principal: string,
    from: State[],
    state: State,
    patch: Partial<Pick<Plan, "approved_at" | "outcome">> = {},
    lock?: string,
  ): Plan {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const before = this.get(id, principal);
      if (!from.includes(before.state))
        throw new PluginError(
          "invalid_state",
          "The operation is no longer in the expected state; inspect it before proceeding.",
        );
      if (lock) {
        const conflict = this.db.prepare("SELECT plan_id FROM locks WHERE resource=?").get(lock);
        if (conflict)
          throw new PluginError(
            "resource_busy",
            "An unreconciled operation already holds this resource.",
          );
        this.db.prepare("INSERT INTO locks(resource,plan_id) VALUES(?,?)").run(lock, id);
      }
      const plan = { ...before, ...patch, state, updated_at: Date.now() };
      this.db
        .prepare("UPDATE operations SET state=?,data=? WHERE id=? AND principal=?")
        .run(state, JSON.stringify(plan), id, principal);
      if (terminal.has(state)) this.db.prepare("DELETE FROM locks WHERE plan_id=?").run(id);
      this.event(plan);
      this.db.exec("COMMIT");
      return plan;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  /** Trusted approval channel only. Never expose this method as an MCP tool. */
  approve(id: string, principal: string, hash: string, now = Date.now()): Plan {
    const plan = this.get(id, principal);
    if (plan.hash !== hash)
      throw new PluginError("plan_mismatch", "The reviewed plan does not match this decision.");
    if (plan.expires_at <= now)
      throw new PluginError(
        "plan_expired",
        "The plan has expired. Inspect current state and create a new plan.",
      );
    return this.transition(id, principal, ["planned"], "approved", { approved_at: now });
  }
  close(): void {
    this.db.close();
    if (this.lockPath) {
      try {
        const lock = JSON.parse(readFileSync(this.lockPath, "utf8"));
        if (lock.id === this.lockId) unlinkSync(this.lockPath);
      } catch {
        /* Keep an uncertain lock for operator inspection. */
      }
      this.lockPath = undefined;
    }
  }
}
