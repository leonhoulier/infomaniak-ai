import { z } from "zod";
import { domainToASCII } from "node:url";
import { PluginError } from "./errors.js";
import { list, object, type Api } from "./provider.js";

export const DNS_SCOPE = "infomaniak:write:dns";
export const MAIL_SCOPE = "infomaniak:write:mail";
export const DEPLOY_SCOPE = "infomaniak:deploy";
export const RESOURCE_SCOPES = [DNS_SCOPE, MAIL_SCOPE, DEPLOY_SCOPE];
export interface MailboxResource {
  hosting: number;
  name: string;
  address: string;
}
export interface ResourceConsent {
  zones: string[];
  mailboxes: MailboxResource[];
  deployments?: { runner: string; app: string }[];
  deploymentEnrollment?: boolean;
}
export function domainName(input: string): string {
  const value = domainToASCII(input.trim().toLowerCase().replace(/\.$/, ""));
  if (
    value.length < 3 ||
    value.length > 253 ||
    !value.includes(".") ||
    value.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new PluginError("invalid_input", "Enter an exact domain name, without a URL or path.");
  return value;
}
export async function accountProducts(
  api: Api,
  account: number,
): Promise<Record<string, unknown>[]> {
  const rows = list(
    await api.request("GET", "/1/products?account_id=" + account + "&per_page=1000"),
  );
  if (rows.length >= 1000)
    throw new PluginError(
      "inventory_limit",
      "This account needs paginated inventory support before resource access can be verified.",
    );
  return rows.map(object).filter((p) => p.account_id === account && Number.isSafeInteger(p.id));
}
export function isMailProduct(p: Record<string, unknown>): boolean {
  return ["email_hosting", "mail", "mail_hosting"].includes(String(p.service_name));
}
export async function verifyResources(
  api: Api,
  account: number,
  zones: string[],
  addresses: string[],
): Promise<ResourceConsent> {
  if (zones.length > 20 || addresses.length > 20)
    throw new PluginError(
      "invalid_input",
      "Choose at most 20 domains and 20 mailboxes per connection.",
    );
  const products = await accountProducts(api, account),
    domains = [...new Set(zones.map(domainName))],
    mailboxes: MailboxResource[] = [];
  for (const zone of domains)
    if (
      !products.some(
        (p) => p.service_name === "domain" && String(p.customer_name).toLowerCase() === zone,
      )
    )
      throw new PluginError(
        "resource_not_found",
        "A requested domain is not registered in the selected account. Check the name and token product permissions.",
      );
  for (const input of [...new Set(addresses.map((v) => v.trim().toLowerCase()))]) {
    const address = z.string().email().max(254).parse(input),
      candidates = products.filter(
        (p) =>
          isMailProduct(p) &&
          String(p.customer_name).toLowerCase().replace(/\.$/, "") === address.split("@")[1],
      );
    const matches: MailboxResource[] = [];
    for (const p of candidates) {
      const rows = list(
        await api.request("GET", "/1/mail_hostings/" + p.id + "/mailboxes?per_page=1000"),
      );
      if (rows.length >= 1000)
        throw new PluginError(
          "inventory_limit",
          "Narrow this mail hosting before granting mailbox access.",
        );
      for (const value of rows) {
        const row = object(value);
        if (
          String(row.mailbox ?? row.email).toLowerCase() === address &&
          typeof row.mailbox_name === "string"
        )
          matches.push({ hosting: Number(p.id), name: row.mailbox_name, address });
      }
    }
    if (matches.length !== 1)
      throw new PluginError(
        "resource_not_found",
        "A requested mailbox was not uniquely found in this account. Use its full existing address and check mail-service permissions.",
      );
    mailboxes.push(matches[0]!);
  }
  return { zones: domains, mailboxes };
}
export async function verifyMailbox(
  api: Api,
  account: number,
  mailbox: MailboxResource,
): Promise<void> {
  const products = await accountProducts(api, account);
  if (!products.some((p) => p.id === mailbox.hosting && isMailProduct(p)))
    throw new PluginError(
      "access_denied",
      "The mailbox hosting no longer belongs to this account.",
    );
  const row = object(
    await api.request(
      "GET",
      "/1/mail_hostings/" + mailbox.hosting + "/mailboxes/" + encodeURIComponent(mailbox.name),
    ),
  );
  if (
    row.mailbox_name !== mailbox.name ||
    String(row.mailbox ?? row.email).toLowerCase() !== mailbox.address
  )
    throw new PluginError(
      "access_denied",
      "The consented mailbox identity has changed. Connect again to review access.",
    );
}
export function resourceWords(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[\n,]/)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}
