import { isIP } from "node:net";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Backend } from "./backend.js";
import type { Principal, ResourceKind } from "./access.js";
import { digest } from "./access.js";
import { PluginError } from "./errors.js";
import { list, object, type Api } from "./provider.js";

// Plan hashes must not depend on the machine's locale or ICU version.
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => compare(a, b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export const fingerprint = (value: unknown): string => digest(canonical(value));
export type Args = Record<string, unknown>;
export interface RequestSpec {
  method: "POST" | "PUT" | "DELETE";
  path: string;
  body?: Args;
}
export interface Change {
  before: unknown;
  after: unknown;
  request: RequestSpec;
  impact: string;
  recovery: string;
  resource: string;
}
export interface Operation {
  id: string;
  product: string;
  summary: string;
  method: string;
  path: string;
  input: z.AnyZodObject | z.ZodEffects<z.AnyZodObject>;
  revision: string;
  write: boolean;
  /** Infomaniak-specific facts a model needs to use this operation correctly. */
  notes?: string[];
  requiresBackend?: boolean;
  resource?: (args: Args) => { kind: ResourceKind; key: string };
  read?: (api: Api, args: Args, principal: Principal, backend?: Backend) => Promise<unknown>;
  inspect?: (api: Api, args: Args) => Promise<unknown>;
  change?: (args: Args, before: unknown) => Change;
  matches?: (actual: unknown, expected: unknown) => boolean;
}
const id = z.number().int().positive().safe();
const zone = z
  .string()
  .min(3)
  .max(253)
  .regex(/^(?=.{3,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/)
  .refine((s) => !s.includes(".."));
const local = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9!#$&'*+_=\-\x5e\x60{|}~.]+$/)
  .refine((s) => s !== "." && s !== ".." && !s.includes(".."));
const email = z
  .string()
  .email()
  .max(254)
  .refine((s) => !/[\r\n]/.test(s));
const base = { account_id: id };
const dns = { ...base, zone };
const mail = { ...base, mail_hosting_id: id, mailbox_name: local };
const ttl = z.number().int().min(60).max(86400);
const value = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => !/[\r\n\0]/.test(s));
const dnsFields = {
  source: z
    .string()
    .min(1)
    .max(253)
    .regex(/^(?:\.|[A-Za-z0-9_*][A-Za-z0-9_*.\-]*)$/)
    .refine((s) => !s.includes("..")),
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "CAA", "NS"]),
  target: value,
  ttl,
};
const dnsBase = (a: Args): string => "/2/zones/" + encodeURIComponent(String(a.zone)) + "/records";
const mailBase = (a: Args): string =>
  "/1/mail_hostings/" +
  a.mail_hosting_id +
  "/mailboxes/" +
  encodeURIComponent(String(a.mailbox_name));
const scopeDns = (a: Args): { kind: ResourceKind; key: string } => ({
  kind: "zones",
  key: String(a.zone),
});
const scopeDnsWrite = (a: Args): { kind: ResourceKind; key: string } =>
  typeof (a.source ?? a.expected_source) === "string"
    ? { kind: "dns_names", key: String(a.zone) + ":" + String(a.source ?? a.expected_source) }
    : scopeDns(a);
const scopeMail = (a: Args): { kind: ResourceKind; key: string } =>
  a.mailbox_name === undefined
    ? { kind: "mail_hostings", key: String(a.mail_hosting_id) }
    : { kind: "mailboxes", key: String(a.mail_hosting_id) + ":" + String(a.mailbox_name) };
const sorted = <T>(array: T[]): T[] => array.sort((a, b) => compare(canonical(a), canonical(b)));
const bool = (v: unknown): boolean => {
  if ([true, 1, "1", "true"].includes(v as never)) return true;
  if ([false, 0, "0", "false"].includes(v as never)) return false;
  throw new PluginError("invalid_response", "Provider returned an unknown boolean representation.");
};
async function dnsState(api: Api, a: Args): Promise<unknown> {
  return sorted(
    list(await api.request("GET", dnsBase(a))).map((v) => {
      const r = object(v);
      if (
        !Number.isSafeInteger(r.id) ||
        (typeof r.source !== "string" && r.source !== null) ||
        typeof r.type !== "string" ||
        typeof r.target !== "string" ||
        !Number.isSafeInteger(r.ttl)
      )
        throw new PluginError(
          "invalid_response",
          "Incomplete DNS records cannot be used for a write plan.",
        );
      return { id: r.id, source: r.source || ".", type: r.type, target: r.target, ttl: r.ttl };
    }),
  );
}
async function aliasState(api: Api, a: Args): Promise<unknown> {
  const data = object(await api.request("GET", mailBase(a) + "/aliases"));
  return {
    enabled_alias: bool(data.enabled_alias),
    aliases: sorted(
      list(data.aliases).map((v) => {
        if (typeof v !== "string") throw new PluginError("invalid_response", "Invalid alias list.");
        return v.split("@")[0]!;
      }),
    ),
  };
}
async function dnsWriteState(api: Api, a: Args): Promise<unknown> {
  const records = list(await dnsState(api, a)),
    source = a.source ?? a.expected_source;
  return typeof source === "string" ? records.filter((r) => object(r).source === source) : records;
}
async function forwardState(api: Api, a: Args): Promise<unknown> {
  const data = object(await api.request("GET", mailBase(a) + "/forwarding_addresses"));
  return {
    is_enabled: bool(data.is_enabled),
    has_dont_deliver: bool(data.has_dont_deliver),
    has_forward_spam: bool(data.has_forward_spam),
    redirect_addresses: sorted(
      list(data.redirect_adresses ?? data.redirect_addresses).map((v) => {
        const e = typeof v === "string" ? v : object(v).email;
        return email.parse(e);
      }),
    ),
  };
}
const recordsMatch = (a: unknown, b: unknown): boolean => {
  const semantic = (data: unknown) =>
    sorted(
      list(data).map((v) => {
        const { id: _, ...rest } = object(v);
        return rest;
      }),
    );
  return canonical(semantic(a)) === canonical(semantic(b));
};
const recoveryDns =
  "Restoring a record is a new approved change. DNS caches can retain old values until TTL expiry; no universal undo or atomicity is promised.";
const recoveryMail =
  "Restoring this configuration requires a separate approved change. Already delivered, forwarded or rejected mail cannot be recalled.";
/** Product fields worth showing; the rest is billing and rights metadata. */
export function productSummary(value: unknown): Record<string, unknown> {
  const r = object(value);
  return Object.fromEntries(
    [
      "id",
      "account_id",
      "service_id",
      "service_name",
      "customer_name",
      "internal_name",
      "expired_at",
      "is_locked",
      "has_maintenance",
      "has_operation_in_progress",
    ]
      .filter((k) => Object.hasOwn(r, k))
      .map((k) => [k, r[k]]),
  );
}
const mailboxSummary = (value: unknown): Record<string, unknown> => {
  const r = object(value);
  return {
    mailbox_name: r.mailbox_name,
    email: r.mailbox,
    type: r.type ?? null,
    is_free_mail: r.is_free_mail,
    is_limited: r.is_limited,
  };
};
function mutation(o: Omit<Operation, "revision" | "write">): Operation {
  return { ...o, revision: "1", write: true };
}
function reading(o: Omit<Operation, "revision" | "write">): Operation {
  return { ...o, revision: "1", write: false };
}
const operations: Operation[] = [
  reading({
    id: "accounts.list",
    notes: [
      "An account ID is not a product ID, a mail hosting ID or a service_id; never substitute one for another.",
    ],
    product: "Core Resources",
    summary: "List only the accounts granted to this connection.",
    method: "GET",
    path: "/1/accounts",
    input: z.object(base).strict(),
    read: async (api, _a, p) =>
      list(await api.request("GET", "/1/accounts"))
        .map(object)
        .filter((r) => p.accounts.includes(Number(r.id)))
        .map((r) => ({ id: r.id, name: r.name ?? r.customer_name ?? "" })),
  }),
  reading({
    id: "products.list",
    notes: [
      "service_name tells products apart: domain, email_hosting, hosting (some accounts report web hosting as web_hosting), cloud (VPS / Cloud Server, service_id 25; not OpenStack Public Cloud).",
      "For an email_hosting product, id is the mail_hosting_id used by mail operations.",
      "expired_at is a Unix timestamp in UTC; the Manager shows local time.",
    ],
    product: "Core Resources",
    summary: "Inspect products in an explicitly granted account.",
    method: "GET",
    path: "/1/products",
    input: z.object(base).strict(),
    read: async (api, a) =>
      list(
        await api.request("GET", "/1/products?account_id=" + a.account_id + "&per_page=1000"),
      ).map(productSummary),
  }),
  reading({
    id: "dns.records.list",
    notes: [
      'The zone apex has source "." in the API; zone files write it as @.',
      'MX priority is part of the target ("10 mx.example.com"); there is no priority field.',
      "TXT targets can include their quotes; compare targets literally.",
    ],
    product: "Domain & Zone",
    summary: "Inspect the complete DNS record list in a granted zone.",
    method: "GET",
    path: "/2/zones/{zone}/records",
    resource: scopeDns,
    input: z.object(dns).strict(),
    read: dnsState,
  }),
  reading({
    id: "mail.mailboxes.list",
    notes: [
      "mailbox_name is the part before @; pass it, not the full address, to mailbox operations.",
      "mail_hosting_id is the email_hosting product id, not the account id.",
    ],
    product: "Mail Services",
    summary: "List mailbox names and addresses in a granted mail hosting.",
    method: "GET",
    path: "/1/mail_hostings/{mail_hosting_id}/mailboxes",
    resource: scopeMail,
    input: z.object({ ...base, mail_hosting_id: id }).strict(),
    read: async (api, a) =>
      list(
        await api.request(
          "GET",
          "/1/mail_hostings/" + a.mail_hosting_id + "/mailboxes?per_page=1000",
        ),
      ).map(mailboxSummary),
  }),
  reading({
    id: "mail.mailbox.get",
    notes: ["mailbox_name is the part before @."],
    product: "Mail Services",
    summary: "Inspect mailbox metadata without users, messages or credential fields.",
    method: "GET",
    path: "/1/mail_hostings/{mail_hosting_id}/mailboxes/{mailbox_name}",
    resource: scopeMail,
    input: z.object(mail).strict(),
    read: async (api, a) => mailboxSummary(await api.request("GET", mailBase(a))),
  }),
  reading({
    id: "mail.aliases.list",
    notes: ["Aliases are returned as the part before @; alias writes take the same form."],
    product: "Mail Services",
    summary: "Inspect aliases for a mailbox in a granted hosting.",
    method: "GET",
    path: "/1/mail_hostings/{mail_hosting_id}/mailboxes/{mailbox_name}/aliases",
    resource: scopeMail,
    input: z.object(mail).strict(),
    read: aliasState,
  }),
  reading({
    id: "mail.forwarding.get",
    notes: [
      "has_dont_deliver=true means no local copy is kept: mail only goes to the recipients.",
      "Recipients with is_enabled=false forward nothing.",
      "Mailbox forwarding is separate from hosting-level redirections.",
    ],
    product: "Mail Services",
    summary: "Inspect forwarding recipients and delivery flags.",
    method: "GET",
    path: "/1/mail_hostings/{mail_hosting_id}/mailboxes/{mailbox_name}/forwarding_addresses",
    resource: scopeMail,
    input: z.object(mail).strict(),
    read: forwardState,
  }),
  mutation({
    id: "dns.record.create",
    product: "Domain & Zone",
    summary: "Plan one DNS record creation; requires independent approval.",
    method: "POST",
    path: "/2/zones/{zone}/records",
    resource: scopeDnsWrite,
    input: z
      .object({ ...dns, ...dnsFields })
      .strict()
      .superRefine((a, ctx) => {
        if ((a.type === "A" && isIP(a.target) !== 4) || (a.type === "AAAA" && isIP(a.target) !== 6))
          ctx.addIssue({ code: "custom", message: "IP address does not match record type" });
      }),
    inspect: dnsWriteState,
    matches: recordsMatch,
    change: (a, b) => {
      const after = { source: a.source, type: a.type, target: a.target, ttl: a.ttl };
      return {
        before: b,
        after: sorted([...list(b), after]),
        request: { method: "POST", path: dnsBase(a), body: after },
        resource: "dns:" + a.zone,
        impact:
          "Create a public DNS record. DNS changes can affect websites, mail and service verification.",
        recovery: recoveryDns,
      };
    },
  }),
  mutation({
    id: "dns.record.update",
    notes: ["Only target and TTL change; a different source or type needs delete + create."],
    product: "Domain & Zone",
    summary: "Plan a DNS target/TTL update; source/type changes require a different record.",
    method: "PUT",
    path: "/2/zones/{zone}/records/{record}",
    resource: scopeDnsWrite,
    input: z
      .object({
        ...dns,
        record_id: id,
        expected_source: dnsFields.source
          .optional()
          .describe(
            "Required for a named DNS grant; must match the existing record source. This does not rename the record.",
          ),
        target: value.optional(),
        ttl: ttl.optional(),
      })
      .strict()
      .refine((a) => a.target !== undefined || a.ttl !== undefined),
    inspect: dnsWriteState,
    matches: recordsMatch,
    change: (a, b) => {
      const rows = list(b).map(object),
        row = rows.find((r) => r.id === a.record_id);
      if (!row) throw new PluginError("resource_not_found", "The selected record is absent.");
      const body = {
        ...(a.target !== undefined ? { target: a.target } : {}),
        ...(a.ttl !== undefined ? { ttl: a.ttl } : {}),
      };
      return {
        before: b,
        after: sorted(rows.map((r) => (r.id === a.record_id ? { ...r, ...body } : r))),
        request: { method: "PUT", path: dnsBase(a) + "/" + a.record_id, body },
        resource: "dns:" + a.zone,
        impact:
          "Change an existing DNS target/TTL; this may interrupt service. The public update API does not change source/type.",
        recovery: recoveryDns,
      };
    },
  }),
  mutation({
    id: "dns.record.delete",
    product: "Domain & Zone",
    summary: "Plan deletion of one exact DNS record.",
    method: "DELETE",
    path: "/2/zones/{zone}/records/{record}",
    resource: scopeDnsWrite,
    input: z
      .object({ ...dns, record_id: id, expected_source: dnsFields.source.optional() })
      .strict(),
    inspect: dnsWriteState,
    matches: recordsMatch,
    change: (a, b) => {
      if (!list(b).some((v) => object(v).id === a.record_id))
        throw new PluginError("resource_not_found", "The selected record is absent.");
      return {
        before: b,
        after: list(b).filter((v) => object(v).id !== a.record_id),
        request: { method: "DELETE", path: dnsBase(a) + "/" + a.record_id },
        resource: "dns:" + a.zone,
        impact: "Delete this DNS record. This can interrupt websites, mail or verification.",
        recovery: recoveryDns,
      };
    },
  }),
];
for (const action of ["add", "delete"] as const)
  operations.push(
    mutation({
      id: "mail.alias." + action,
      product: "Mail Services",
      summary: "Plan " + action + " of one mailbox alias.",
      method: action === "add" ? "POST" : "DELETE",
      path:
        "/1/mail_hostings/{mail_hosting_id}/mailboxes/{mailbox_name}/aliases" +
        (action === "delete" ? "/{alias}" : ""),
      resource: scopeMail,
      input: z.object({ ...mail, alias: local }).strict(),
      inspect: aliasState,
      change: (a, b) => {
        const before = object(b),
          aliases = list(before.aliases) as string[];
        if (aliases.includes(String(a.alias)) === (action === "add"))
          throw new PluginError("no_change", "The alias is already in the requested state.");
        return {
          before: b,
          after: {
            ...before,
            aliases: sorted(
              action === "add"
                ? [...aliases, String(a.alias)]
                : aliases.filter((v) => v !== a.alias),
            ),
          },
          request:
            action === "add"
              ? { method: "POST", path: mailBase(a) + "/aliases", body: { alias: a.alias } }
              : {
                  method: "DELETE",
                  path: mailBase(a) + "/aliases/" + encodeURIComponent(String(a.alias)),
                },
          resource: "mail:" + a.mail_hosting_id + ":" + a.mailbox_name,
          impact:
            "Change which addresses reach this mailbox. Existing aliases and delivery state are included in the precondition.",
          recovery: recoveryMail,
        };
      },
    }),
  );
for (const action of ["add", "delete"] as const)
  operations.push(
    mutation({
      id: "mail.forwarding." + action,
      product: "Mail Services",
      summary: "Plan " + action + " of one mailbox forwarding recipient.",
      method: action === "add" ? "POST" : "DELETE",
      path:
        "/1/mail_hostings/{mail_hosting_id}/mailboxes/{mailbox_name}/forwarding_addresses" +
        (action === "delete" ? "/{redirect_addresses}" : ""),
      resource: scopeMail,
      input: z.object({ ...mail, redirect_address: email }).strict(),
      inspect: forwardState,
      change: (a, b) => {
        const before = object(b),
          recipients = list(before.redirect_addresses) as string[];
        if (recipients.includes(String(a.redirect_address)) === (action === "add"))
          throw new PluginError(
            "no_change",
            "The forwarding recipient is already in the requested state.",
          );
        return {
          before: b,
          after: {
            ...before,
            redirect_addresses: sorted(
              action === "add"
                ? [...recipients, String(a.redirect_address)]
                : recipients.filter((v) => v !== a.redirect_address),
            ),
          },
          request:
            action === "add"
              ? {
                  method: "POST",
                  path: mailBase(a) + "/forwarding_addresses",
                  body: { redirect_address: a.redirect_address },
                }
              : {
                  method: "DELETE",
                  path:
                    mailBase(a) +
                    "/forwarding_addresses/" +
                    encodeURIComponent(String(a.redirect_address)),
                },
          resource: "mail:" + a.mail_hosting_id + ":" + a.mailbox_name,
          impact:
            "Change an external recipient of future mail. Forwarded messages cannot be recalled.",
          recovery: recoveryMail,
        };
      },
    }),
  );
operations.push(
  mutation({
    id: "mail.forwarding.update",
    notes: ["Disabling forwarding removes every recipient; the plan shows the loss."],
    product: "Mail Services",
    summary: "Plan forwarding settings, including recipient loss when forwarding is disabled.",
    method: "PUT",
    path: "/1/mail_hostings/{mail_hosting_id}/mailboxes/{mailbox_name}/forwarding_addresses",
    resource: scopeMail,
    input: z
      .object({
        ...mail,
        is_enabled: z.boolean().optional(),
        has_dont_deliver: z.boolean().optional(),
        has_forward_spam: z.boolean().optional(),
        redirect_addresses: z
          .array(email)
          .min(1)
          .max(100)
          .refine((a) => new Set(a).size === a.length)
          .optional(),
      })
      .strict()
      .refine(
        (a) =>
          Object.keys(a).length > 3 &&
          !(a.is_enabled === false && a.redirect_addresses !== undefined),
      ),
    inspect: forwardState,
    change: (a, b) => {
      const { account_id: _, mail_hosting_id: __, mailbox_name: ___, ...body } = a;
      const before = object(b),
        after = { ...before, ...body };
      if (a.is_enabled === false) after.redirect_addresses = [];
      if (Array.isArray(after.redirect_addresses))
        after.redirect_addresses = sorted([...after.redirect_addresses]);
      return {
        before: b,
        after,
        request: { method: "PUT", path: mailBase(a) + "/forwarding_addresses", body },
        resource: "mail:" + a.mail_hosting_id + ":" + a.mailbox_name,
        impact:
          "Change mail delivery. Disabling forwarding removes all existing forwarding addresses; has_dont_deliver=true prevents local delivery.",
        recovery: recoveryMail,
      };
    },
  }),
);
for (const [name, backendName, fields, scope] of [
  ["vps.list", "infomaniak_list_vps", { ...base }, undefined],
  [
    "vps.firewall.get",
    "infomaniak_get_vps_firewall",
    { ...base, vps_id: id },
    (a: Args) => ({ kind: "vps" as const, key: String(a.vps_id) }),
  ],
] as const)
  operations.push(
    reading({
      id: name,
      product: "VPS (reviewed MCP adapter)",
      notes: [
        "cloud products are VPS. The public API offers list and firewall reads; there is no lifecycle (start/stop/reboot) API.",
      ],
      summary: "Use the existing reviewed token-only MCP read for " + name + ".",
      method: "GET",
      path: name === "vps.list" ? "/2/vps" : "/2/vps/{vps_id}/firewall",
      requiresBackend: true,
      input: z.object(fields).strict(),
      ...(scope ? { resource: scope } : {}),
      read: async (_api, a, _p, backend) => {
        if (!backend)
          throw new PluginError(
            "operation_unavailable",
            "Configure a reviewed MCP backend for VPS support.",
          );
        const catalogue = await backend.catalogue();
        if (
          !catalogue.tools.some(
            (t) => t.name === "infomaniak_get_vps_firewall" && t.annotations?.readOnlyHint === true,
          )
        )
          throw new PluginError(
            "operation_unavailable",
            "The selected backend lacks reviewed token-only VPS support.",
          );
        const response = await backend.read(backendName, a);
        if (response.isError)
          throw new PluginError(
            "provider_error",
            "The reviewed backend could not complete this read.",
          );
        return response.structuredContent ?? { content: response.content };
      },
    }),
  );
export const OPERATIONS = new Map(operations.map((o) => [o.id, o]));
export function inputSchema(operation: Operation): Record<string, unknown> {
  return zodToJsonSchema(operation.input, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}
export function requireOperation(id: string): Operation {
  const op = OPERATIONS.get(id);
  if (!op)
    throw new PluginError(
      "operation_denied",
      "This operation is catalogued only or has no reviewed handler. It cannot execute.",
    );
  return op;
}
