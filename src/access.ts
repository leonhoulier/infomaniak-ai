import { lstat, readFile } from "node:fs/promises";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { PluginError } from "./errors.js";

const positive = z.number().int().positive().safe();
const binding = z
  .object({
    account_id: positive,
    disposable: z.boolean().default(false),
    writable: z.boolean().default(false),
  })
  .strict();
const PrincipalSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    credential_env: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
    access_token_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    approval_token_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    accounts: z.array(positive).min(1).max(100),
    resources: z
      .object({
        zones: z.record(z.string(), binding).default({}),
        dns_names: z.record(z.string(), binding).default({}),
        mail_hostings: z.record(z.string(), binding).default({}),
        mailboxes: z.record(z.string(), binding).default({}),
        vps: z.record(z.string(), binding).default({}),
      })
      .strict()
      .prefault({}),
    operations: z.array(z.string().min(1).max(120)).max(200),
    writes: z.enum(["disabled", "disposable-only", "enabled"]).default("disabled"),
  })
  .strict();
export const AccessSchema = z
  .object({
    version: z.literal(1),
    state_directory: z.string().refine(isAbsolute),
    local_principal: z.string().optional(),
    principals: z.array(PrincipalSchema).min(1).max(100),
    backend: z
      .object({
        path: z.string().refine(isAbsolute),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    remote: z
      .object({
        host: z.enum(["127.0.0.1", "::1", "0.0.0.0"]).default("127.0.0.1"),
        port: z.number().int().min(1).max(65535).default(8787),
        public_origin: z.string().url(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const ids = new Set<string>(),
      hashes = new Set<string>();
    for (const p of config.principals) {
      if (ids.has(p.id)) ctx.addIssue({ code: "custom", message: "Duplicate principal" });
      ids.add(p.id);
      for (const h of [p.access_token_sha256, p.approval_token_sha256]) {
        if (!h) continue;
        if (hashes.has(h))
          ctx.addIssue({
            code: "custom",
            message: "Credentials must be unique across principals and roles",
          });
        hashes.add(h);
      }
      for (const resources of Object.values(p.resources)) {
        for (const b of Object.values(resources)) {
          if (!p.accounts.includes(b.account_id))
            ctx.addIssue({
              code: "custom",
              message: "Resource binding outside permitted accounts",
            });
        }
      }
      if (config.remote && (!p.access_token_sha256 || !p.approval_token_sha256))
        ctx.addIssue({
          code: "custom",
          message: "Remote principals need separate client and approval credentials",
        });
    }
    if (config.local_principal && !ids.has(config.local_principal))
      ctx.addIssue({ code: "custom", message: "Unknown local principal" });
    if (config.remote) {
      const u = new URL(config.remote.public_origin);
      if (
        u.origin !== config.remote.public_origin ||
        u.username ||
        u.password ||
        (u.protocol !== "https:" &&
          !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
      )
        ctx.addIssue({
          code: "custom",
          message: "Remote origin requires HTTPS, except loopback development",
        });
    }
  });
export type Access = z.infer<typeof AccessSchema>;
export type Principal = Access["principals"][number];
export type ResourceKind = keyof Principal["resources"];

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function matchesSecret(value: string, expected?: string): boolean {
  return !!expected && timingSafeEqual(Buffer.from(digest(value)), Buffer.from(expected));
}
export async function loadAccess(path: string): Promise<Access> {
  if (!isAbsolute(path))
    throw new PluginError("invalid_configuration", "Use an absolute policy file path.");
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 256_000 ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new PluginError(
      "invalid_configuration",
      "The policy must be a private regular file (mode 0600).",
    );
  try {
    return AccessSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    throw new PluginError(
      "invalid_configuration",
      "Invalid policy. Check its schema; no credential values are included in this error.",
    );
  }
}
export function loadProviderSecret(name: string, env: NodeJS.ProcessEnv = process.env): string {
  let value = env[name];
  const file = env[name + "_FILE"];
  if (file) {
    if (value || !isAbsolute(file))
      throw new PluginError(
        "invalid_configuration",
        "Choose one provider credential source and use an absolute secret-file path.",
      );
    try {
      const info = lstatSync(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 8192 ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      )
        throw new Error("Unsafe secret file");
      value = readFileSync(file, "utf8").trim();
    } catch {
      throw new PluginError(
        "configuration_required",
        "The provider secret file must be readable, private and regular (mode 0600).",
      );
    }
  }
  if (!value || value.length < 20 || value.length > 8192 || /\s/.test(value))
    throw new PluginError(
      "configuration_required",
      "Configure the principal's provider credential through its secret environment variable or private _FILE source.",
    );
  return value;
}
export function credential(principal: Principal, env: NodeJS.ProcessEnv = process.env): string {
  const value = loadProviderSecret(principal.credential_env, env);
  if (
    matchesSecret(value, principal.access_token_sha256) ||
    matchesSecret(value, principal.approval_token_sha256)
  )
    throw new PluginError(
      "invalid_configuration",
      "Provider, MCP and approval credentials must be separate.",
    );
  return value;
}
export function authorize(
  principal: Principal,
  operation: string,
  account: unknown,
  resource?: { kind: ResourceKind; key: string },
  write = false,
): void {
  if (
    !principal.operations.includes(operation) ||
    !Number.isSafeInteger(account) ||
    !principal.accounts.includes(Number(account))
  )
    throw new PluginError(
      "access_denied",
      "This operation or account is outside the connection's policy.",
    );
  let b = resource ? principal.resources[resource.kind][resource.key] : undefined;
  // A named DNS grant is narrow. Whole-zone writes require a separate explicit
  // writable zone grant; an inventory read grant never widens write access.
  if (!b && resource?.kind === "dns_names") {
    const zone = principal.resources.zones[resource.key.split(":")[0]!];
    if (zone?.writable) b = zone;
  }
  if (resource && (!b || b.account_id !== account))
    throw new PluginError(
      "access_denied",
      "This resource is outside the selected account's explicit grants.",
    );
  if (
    write &&
    (!b?.writable ||
      principal.writes === "disabled" ||
      (principal.writes === "disposable-only" && !b?.disposable))
  )
    throw new PluginError(
      "writes_disabled",
      "Writes are disabled for this resource. Review the policy and disposable test requirements.",
    );
}
