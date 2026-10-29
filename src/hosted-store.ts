import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, chmodSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { PluginError } from "./errors.js";

export const opaque = () => randomBytes(32).toString("base64url");
export const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
function privateFile(file: string): void {
  const info = lstatSync(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
  )
    throw new PluginError(
      "unsafe_hosted_storage",
      "Hosted keys and state must be private regular files owned by this user (0600).",
    );
}
export function readHostedKey(file: string): Buffer {
  if (!isAbsolute(file))
    throw new PluginError("invalid_configuration", "Use an absolute hosted key file path.");
  privateFile(file);
  if (lstatSync(file).size > 128)
    throw new PluginError("invalid_configuration", "Invalid hosted encryption key.");
  const encoded = readFileSync(file, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded))
    throw new PluginError(
      "invalid_configuration",
      "Expected a generated 32-byte hosted encryption key.",
    );
  return Buffer.from(encoded, "base64url");
}
interface Row {
  id: string;
  data: string;
  expires: number;
}
/** Only encrypted values and opaque identifiers reach SQLite, including its WAL. */
export class HostedStore {
  private readonly db: DatabaseSync;
  constructor(
    readonly directory: string,
    private readonly key: Buffer,
    readonly now = Date.now,
  ) {
    if (!isAbsolute(directory) || key.length !== 32)
      throw new PluginError(
        "invalid_configuration",
        "Use an absolute hosted state directory and a 32-byte key.",
      );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
    )
      throw new PluginError(
        "unsafe_hosted_storage",
        "Hosted state must be a private directory owned by this user (0700).",
      );
    const file = join(directory, "hosted.sqlite");
    try {
      closeSync(openSync(file, "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    privateFile(file);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        privateFile(file + suffix);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;",
      );
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS entries(kind TEXT NOT NULL,id TEXT NOT NULL,expires INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE INDEX IF NOT EXISTS expiry ON entries(expires);",
      );
      for (const suffix of ["-wal", "-shm"]) {
        try {
          chmodSync(file + suffix, 0o600);
        } catch {
          /* Created when needed. */
        }
      }
      if (this.db.prepare("SELECT 1 FROM entries WHERE kind='meta'").get()) {
        if (this.get<{ version: number }>("meta", "key-check")?.version !== 1)
          throw new Error("Key mismatch");
      } else this.put("meta", "key-check", { version: 1 }, Number.MAX_SAFE_INTEGER);
    } catch {
      this.db.close();
      throw new PluginError(
        "invalid_hosted_key",
        "Hosted state could not be opened with this key. Restore its matching key; do not replace it.",
      );
    }
  }
  private seal(kind: string, id: string, value: unknown): string {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(kind + ":" + id));
    return Buffer.concat([
      iv,
      cipher.update(JSON.stringify(value)),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
  }
  private open<T>(kind: string, id: string, data: string): T {
    const bytes = Buffer.from(data, "base64"),
      decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(kind + ":" + id));
    decipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8"),
    ) as T;
  }
  put(kind: string, id: string, data: unknown, expires: number): void {
    this.db
      .prepare(
        "INSERT INTO entries VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET expires=excluded.expires,data=excluded.data",
      )
      .run(kind, id, expires, this.seal(kind, id, data));
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT data,expires FROM entries WHERE kind=? AND id=? AND expires>?")
      .get(kind, id, this.now()) as unknown as Row | undefined;
    return row ? this.open<T>(kind, id, row.data) : undefined;
  }
  /** Rewrite a live encrypted value without extending expiry or recreating it. */
  replaceValue(kind: string, id: string, value: unknown): void {
    this.db
      .prepare("UPDATE entries SET data=? WHERE kind=? AND id=? AND expires>?")
      .run(this.seal(kind, id, value), kind, id, this.now());
  }
  capExpiry(kind: string, id: string, expires: number): void {
    this.db
      .prepare("UPDATE entries SET expires=MIN(expires,?) WHERE kind=? AND id=?")
      .run(expires, kind, id);
  }
  take<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("DELETE FROM entries WHERE kind=? AND id=? AND expires>? RETURNING data")
      .get(kind, id, this.now()) as unknown as Row | undefined;
    return row ? this.open<T>(kind, id, row.data) : undefined;
  }
  delete(kind: string, id: string): void {
    this.db.prepare("DELETE FROM entries WHERE kind=? AND id=?").run(kind, id);
  }
  list<T>(kind: string): { id: string; value: T }[] {
    return (
      this.db
        .prepare("SELECT id,data FROM entries WHERE kind=? AND expires>?")
        .all(kind, this.now()) as unknown as Row[]
    ).map((r) => ({ id: r.id, value: this.open<T>(kind, r.id, r.data) }));
  }
  atomic<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  prune(): void {
    this.db.prepare("DELETE FROM entries WHERE expires<=?").run(this.now());
    // Access/refresh records contain no provider token, but delete them with their grant too.
    const pendingCodes = new Set(this.list<{ grant: string }>("code").map((r) => r.value.grant));
    for (const { id, value } of this.list<{ activated: boolean }>("grant"))
      if (!value.activated && !pendingCodes.has(id)) this.delete("grant", id);
    const active = new Set(this.list("grant").map((r) => r.id));
    for (const kind of ["access", "refresh", "spent", "code"])
      for (const { id, value } of this.list<{ grant: string }>(kind))
        if (!active.has(value.grant)) this.delete(kind, id);
  }
  close(): void {
    this.db.close();
  }
}
