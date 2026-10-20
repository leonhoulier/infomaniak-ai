import { PluginError } from "./errors.js";

/** Operations reviewed for this adapter; annotations alone cannot admit new tools. */
export const READS = {
  infomaniak_list_organizations: {
    area: "accounts",
    description: "Find accessible account IDs.",
    account: false,
  },
  infomaniak_list_hostings: {
    area: "hosting",
    description: "Find classic and managed Node.js hostings in an explicit account.",
    account: true,
  },
  infomaniak_list_domains: {
    area: "domains",
    description: "List domain products in an explicit account.",
    account: true,
  },
  infomaniak_get_domain: {
    area: "domains",
    description: "Inspect a domain's DNS management and configuration.",
    account: false,
  },
  infomaniak_dns_list_records: {
    area: "dns",
    description: "Inspect records in an explicit DNS zone.",
    account: false,
  },
  infomaniak_dns_export: {
    area: "dns",
    description: "Return a zone export as JSON or CSV.",
    account: false,
  },
  infomaniak_dns_diff: {
    area: "dns",
    description: "Compare desired records with a zone without applying changes.",
    account: false,
  },
  infomaniak_dns_check_propagation: {
    area: "dns",
    description: "Check named public DNS resolvers and report lookup errors.",
    account: false,
  },
  infomaniak_list_mail_hostings: {
    area: "mail",
    description: "List mail services in an explicit account.",
    account: true,
  },
  infomaniak_list_mailboxes: {
    area: "mail",
    description: "List mailbox names in an explicit mail hosting.",
    account: false,
  },
  infomaniak_get_mailbox_forwarding: {
    area: "mail",
    description: "Inspect forwarding for one mailbox.",
    account: false,
  },
  infomaniak_list_vps: {
    area: "vps",
    description: "List VPS products in an explicit account when token-only support is present.",
    account: true,
  },
  infomaniak_get_vps_firewall: {
    area: "vps",
    description: "Read provider firewall rules for one VPS.",
    account: true,
  },
} as const;

export type ReadName = keyof typeof READS;

/** Reject writes, generic execution and implicit account selection before connecting. */
export function authorizeRead(name: string, args: Record<string, unknown>): ReadName {
  if (!Object.hasOwn(READS, name)) {
    throw new PluginError(
      "operation_denied",
      "This operation is outside the reviewed read allowlist.",
    );
  }
  if (Object.hasOwn(args, "confirmation_token")) {
    throw new PluginError(
      "operation_denied",
      "Confirmation tokens cannot enable writes through this plugin.",
    );
  }
  const readName = name as ReadName;
  if (
    READS[readName].account &&
    (!Number.isSafeInteger(args["account_id"]) || Number(args["account_id"]) <= 0)
  ) {
    throw new PluginError(
      "account_required",
      "Provide an explicit positive account_id. Discover accounts first; never assume the first account.",
    );
  }
  return readName;
}

/** Enforce the reviewed backend's fetch transport policy, including Request objects. */
export function createReadOnlyFetch(nativeFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if (
      method !== "GET" ||
      (init?.body !== undefined && init.body !== null) ||
      url.origin !== "https://api.infomaniak.com" ||
      url.username ||
      url.password
    ) {
      throw new PluginError(
        "transport_denied",
        "Only GET requests to the public Infomaniak API are allowed.",
      );
    }
    return nativeFetch(input, { ...init, redirect: "error" });
  };
}
