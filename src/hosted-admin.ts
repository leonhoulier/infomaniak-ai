#!/usr/bin/env node
import { parseArgs } from "node:util";
import { mkdir, lstat, realpath, writeFile, rm } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";
import { opaque, HostedStore, readHostedKey } from "./hosted-store.js";
import type { Grant } from "./hosted-oauth.js";
import { PluginError } from "./errors.js";
import { abandonHostedPlan } from "./hosted-writes.js";
import type { Plan } from "./journal.js";

async function main(): Promise<void> {
  const action = process.argv[2];
  let values;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(3),
      options: {
        directory: { type: "string" },
        connection: { type: "string" },
        plan: { type: "string" },
        reason: { type: "string" },
        "acknowledge-uncertain-write": { type: "boolean" },
      },
    }));
  } catch {
    throw new PluginError(
      "invalid_option",
      "Use hosted-admin.js init|list|plans|revoke|abandon --directory PRIVATE_FOLDER. Recovery needs --plan ID --reason TEXT --acknowledge-uncertain-write. Never pass credentials as arguments.",
    );
  }
  if (!values.directory || !["init", "list", "plans", "revoke", "abandon"].includes(action ?? ""))
    throw new PluginError(
      "invalid_option",
      "Use init, list or revoke with an explicit private --directory.",
    );
  const directory = resolve(values.directory);
  if (action === "init") {
    let ancestor = directory;
    const suffix: string[] = [];
    for (;;) {
      try {
        await lstat(ancestor);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        suffix.unshift(basename(ancestor));
        ancestor = dirname(ancestor);
      }
    }
    for (let path = join(await realpath(ancestor), ...suffix); ; path = dirname(path)) {
      try {
        await lstat(join(path, ".git"));
        throw new PluginError(
          "private_location_required",
          "Keep hosted keys and state outside Git.",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (path === dirname(path)) break;
    }
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    try {
      await writeFile(join(directory, "hosted-key"), opaque() + "\n", { mode: 0o600, flag: "wx" });
      await mkdir(join(directory, "state"), { mode: 0o700 });
    } catch {
      await rm(directory, { recursive: true, force: true });
      throw new PluginError(
        "storage_failed",
        "Hosted initialization failed. No new key was retained.",
      );
    }
    console.log(
      "Created a separate private hosted key and state directory. No provider token or user connection was created. Configure the hosted origin before starting.",
    );
    return;
  }
  const store = new HostedStore(
    join(directory, "state"),
    readHostedKey(join(directory, "hosted-key")),
  );
  try {
    store.prune();
    if (action === "list")
      console.log(
        JSON.stringify(
          store.list<Grant>("grant").map(({ id, value }) => ({
            id,
            account: value.account,
            client: value.client,
            expires: new Date(value.expires).toISOString(),
          })),
          null,
          2,
        ),
      );
    else if (action === "plans") {
      console.log(
        JSON.stringify(
          store.list<Plan>("write-plan").map(({ value: p }) => ({
            id: p.id,
            operation: p.operation,
            state: p.state,
            updated_at: p.updated_at,
            connection_active: Boolean(store.get("grant", p.principal)),
          })),
          null,
          2,
        ),
      );
    } else if (action === "abandon") {
      if (!values.plan || !values.reason || values["acknowledge-uncertain-write"] !== true)
        throw new PluginError(
          "recovery_acknowledgement_required",
          "Inspect the provider manually, stop the gateway, then supply --plan, --reason and --acknowledge-uncertain-write. Abandonment never certifies the write outcome.",
        );
      abandonHostedPlan(store, values.plan, values.reason);
      console.log(
        "Unverified operation explicitly abandoned. Its lock was released; the provider outcome remains unverified.",
      );
    } else {
      if (!values.connection || !/^[a-f0-9-]{36}$/.test(values.connection))
        throw new PluginError("invalid_connection", "Choose an observed connection ID from list.");
      store.delete("grant", values.connection);
      store.prune();
      console.log("Connection disconnected and its live stored token deleted.");
    }
  } finally {
    store.close();
  }
}
main().catch((error) => {
  console.error(
    error instanceof PluginError
      ? error.message
      : "Hosted administration failed. Existing state was not overwritten; check private paths and permissions.",
  );
  process.exitCode = 1;
});
