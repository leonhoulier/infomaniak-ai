#!/usr/bin/env node
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { AccessSchema, authorize, digest, loadAccess, matchesSecret } from "./access.js";
import { PluginError } from "./errors.js";
import { Journal } from "./journal.js";
import { OPERATIONS, requireOperation } from "./registry.js";

const { values, positionals: args } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    principal: { type: "string" },
    id: { type: "string" },
    hash: { type: "string" },
    directory: { type: "string" },
    account: { type: "string" },
    zone: { type: "string" },
    "mail-hosting": { type: "string" },
    mailbox: { type: "string" },
    "dns-source": { type: "string" },
    vps: { type: "string" },
    "public-origin": { type: "string" },
    container: { type: "boolean", default: false },
  },
});
async function question(prompt: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY)
    throw new PluginError(
      "human_required",
      "Approval needs an interactive human terminal or the authenticated approval UI.",
    );
  process.stderr.write(prompt);
  const mute = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const readline = createInterface({
    input: process.stdin,
    output: hidden ? mute : process.stderr,
    terminal: true,
  });
  try {
    const answer = await readline.question("");
    if (hidden) process.stderr.write("\n");
    return answer.trim();
  } finally {
    readline.close();
  }
}
async function main(): Promise<void> {
  const command = args[0];
  if (command === "init") {
    const directory = values.directory,
      account = Number(values.account);
    if (!directory || !isAbsolute(directory) || !Number.isSafeInteger(account) || account <= 0)
      throw new PluginError(
        "invalid_input",
        "Use init --directory /absolute/new/private/directory --account ACTUAL_ACCOUNT_ID.",
      );
    const client = randomBytes(32).toString("hex"),
      human = randomBytes(32).toString("hex");
    const resources = {
      dns_names:
        values.zone && values["dns-source"]
          ? {
              [values.zone + ":" + values["dns-source"]]: {
                account_id: account,
                disposable: false,
                writable: false,
              },
            }
          : {},
      zones: values.zone ? { [values.zone]: { account_id: account, disposable: false } } : {},
      mail_hostings: values["mail-hosting"]
        ? { [values["mail-hosting"]]: { account_id: account, disposable: false } }
        : {},
      mailboxes:
        values["mail-hosting"] && values.mailbox
          ? {
              [values["mail-hosting"] + ":" + values.mailbox]: {
                account_id: account,
                disposable: false,
              },
            }
          : {},
      vps: values.vps ? { [values.vps]: { account_id: account, disposable: false } } : {},
    };
    const config = AccessSchema.parse({
      version: 1,
      state_directory: values.container ? "/var/lib/infomaniak-ai" : join(directory, "state"),
      local_principal: "owner",
      principals: [
        {
          id: "owner",
          credential_env: "INFOMANIAK_API_TOKEN",
          access_token_sha256: digest(client),
          approval_token_sha256: digest(human),
          accounts: [account],
          resources,
          operations: [...OPERATIONS.keys()],
          writes: "disabled",
        },
      ],
      remote: {
        host: values.container ? "0.0.0.0" : "127.0.0.1",
        port: 8787,
        public_origin: values["public-origin"] ?? "http://localhost:8787",
      },
    });
    // A new directory is required; never overwrite existing credentials or configuration.
    await mkdir(directory, { mode: 0o700 });
    await mkdir(join(directory, "client"), { mode: 0o700 });
    await mkdir(join(directory, "human"), { mode: 0o700 });
    await writeFile(join(directory, "client", "mcp-token"), client + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(join(directory, "human", "approval-key"), human + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(join(directory, "access.local.json"), JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    console.log(
      JSON.stringify({
        created: directory,
        policy: join(directory, "access.local.json"),
        client_secret_file: join(directory, "client", "mcp-token"),
        human_secret_file: join(directory, "human", "approval-key"),
        writes: "disabled",
        note: "Configure the provider token separately. Keep the human key outside the AI client's configuration.",
      }),
    );
    return;
  }
  if (!values.config)
    throw new PluginError(
      "invalid_input",
      "Use plans, show or approve with --config /absolute/access.local.json --principal NAME.",
    );
  const config = await loadAccess(values.config),
    p = config.principals.find((p) => p.id === (values.principal ?? config.local_principal));
  if (!p) throw new PluginError("invalid_input", "Select a configured principal.");
  const journal = new Journal(config.state_directory);
  try {
    if (command === "plans") {
      console.log(
        JSON.stringify(
          journal.list(p.id).map((r) => ({
            id: r.id,
            operation: r.operation,
            state: r.state,
            hash: r.hash,
            expires_at: r.expires_at,
          })),
          null,
          2,
        ),
      );
      return;
    }
    if (!values.id) throw new PluginError("invalid_input", "Provide --id PLAN_ID.");
    const plan = journal.get(values.id, p.id);
    if (command === "show") {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    if (command !== "approve")
      throw new PluginError("invalid_input", "Supported commands: init, plans, show, approve.");
    if (!values.hash || values.hash !== plan.hash)
      throw new PluginError(
        "plan_mismatch",
        "Provide the exact plan hash displayed during review.",
      );
    const op = requireOperation(plan.operation),
      input = op.input.parse(plan.args);
    authorize(p, op.id, input.account_id, op.resource?.(input), true);
    console.log(JSON.stringify(plan, null, 2));
    const key = await question("Separate human approval key: ", true);
    if (!matchesSecret(key, p.approval_token_sha256))
      throw new PluginError("access_denied", "Approval key was not accepted.");
    const ack = await question("Type APPROVE to approve this exact plan: ");
    if (ack !== "APPROVE") throw new PluginError("not_approved", "No approval recorded.");
    journal.approve(plan.id, p.id, values.hash);
    console.log(JSON.stringify({ approved: plan.id, executed: false }));
  } finally {
    journal.close();
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      error: true,
      code: error instanceof PluginError ? error.code : "administration_failed",
      message:
        error instanceof PluginError
          ? error.message
          : "Administration failed; inspect configuration and filesystem access.",
    }),
  );
  process.exitCode = 1;
});
