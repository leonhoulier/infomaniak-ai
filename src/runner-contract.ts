import { z } from "zod";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { canonical } from "./registry.js";
import { domainName } from "./hosted-resources.js";

export const AppName = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const Revision = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
export const Repository = z
  .string()
  .url()
  .max(500)
  .refine((value) => {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash;
  });
export const AppDefinition = z
  .object({
    name: AppName,
    repository: Repository,
    hostname: z.string().transform(domainName),
    container_port: z.number().int().min(1).max(65535).default(3000),
    health_path: z
      .string()
      .max(300)
      .regex(/^\/[A-Za-z0-9_./-]*$/)
      .default("/"),
    dockerfile: z
      .string()
      .max(200)
      .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+$/)
      .default("Dockerfile"),
    build_context: z
      .string()
      .max(200)
      .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+$/)
      .default("."),
  })
  .strict();
export type AppDefinition = z.infer<typeof AppDefinition>;
export const AppState = z
  .object({
    revision: Revision.nullable(),
    previous_revision: Revision.nullable(),
    healthy: z.boolean(),
    updated_at: z.number().int(),
    url: z.string().url().max(300),
    uncertain: z.boolean().default(false),
    health_scope: z.enum(["loopback", "public-tls"]).default("loopback"),
  })
  .strict();
export type AppState = z.infer<typeof AppState>;
export const Job = z
  .object({
    id: z.string().uuid(),
    runner: z.string().uuid(),
    app: AppName,
    action: z.enum(["deploy", "rollback", "logs"]),
    revision: Revision.optional(),
    definition: AppDefinition,
    expires: z.number().int(),
    plan: z.string().uuid().optional(),
  })
  .strict();
export type Job = z.infer<typeof Job>;
export const JobResult = z
  .object({
    id: z.string().uuid(),
    state: z.enum(["verified", "failed", "unknown"]),
    code: z.enum([
      "ok",
      "build_failed",
      "health_failed",
      "proxy_failed",
      "expired",
      "config_mismatch",
      "hostname_conflict",
      "configuration_error",
      "runner_interrupted",
      "rollback_failed",
      "logs",
    ]),
    app: AppName,
    logs: z.string().max(24000).optional(),
  })
  .strict();
export type JobResult = z.infer<typeof JobResult>;
export const Report = z
  .object({
    apps: z.record(z.string(), AppState).refine((v) => Object.keys(v).length <= 10),
    results: z.array(JobResult).max(1),
    version: z.literal(1),
    host: z
      .object({
        cpus: z.number().int().positive(),
        memory_total: z.number().positive(),
        memory_free: z.number().nonnegative(),
        uptime_seconds: z.number().nonnegative(),
        load: z.array(z.number().nonnegative()).length(3),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Report = z.infer<typeof Report>;
export function signed(value: unknown, privateKey: string): string {
  return sign(null, Buffer.from(canonical(value)), createPrivateKey(privateKey)).toString(
    "base64url",
  );
}
export function validSignature(value: unknown, signature: string, publicKey: string): boolean {
  try {
    const key = createPublicKey(publicKey);
    return (
      key.asymmetricKeyType === "ed25519" &&
      verify(null, Buffer.from(canonical(value)), key, Buffer.from(signature, "base64url"))
    );
  } catch {
    return false;
  }
}
