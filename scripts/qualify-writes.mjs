#!/usr/bin/env node
// Live write qualification on disposable targets, with a human approval before every write.
//
//   INFOMANIAK_API_TOKEN=... node scripts/qualify-writes.mjs \
//     --account 123 --zone example.com --mail-hosting 456 --mailbox throwaway
//
// Touches only the DNS name _infomaniak-ai-test in the zone and the alias ik-ai-test on the
// mailbox. Each step is planned here and approved by you in a second terminal with
// infomaniak-ai-admin. Nothing is approved by this script.
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AccessSchema, digest } from "../dist/access.js";
import { Application } from "../dist/application.js";
import { OPERATIONS } from "../dist/registry.js";

const { values: v } = parseArgs({
  options: {
    account: { type: "string" },
    zone: { type: "string" },
    "mail-hosting": { type: "string" },
    mailbox: { type: "string" },
  },
});
if (
  !process.env.INFOMANIAK_API_TOKEN ||
  !v.account ||
  !v.zone ||
  !v["mail-hosting"] ||
  !v.mailbox
) {
  console.error("Set INFOMANIAK_API_TOKEN and pass --account --zone --mail-hosting --mailbox.");
  process.exit(2);
}
const NAME = "_infomaniak-ai-test",
  ALIAS = "ik-ai-test";
const account = Number(v.account),
  hosting = Number(v["mail-hosting"]),
  mailbox = v.mailbox;
const dir = await mkdtemp(join(tmpdir(), "infomaniak-ai-qualify-"));
const human = randomBytes(32).toString("hex");
const keyFile = join(dir, "human-approval-key");
await writeFile(keyFile, human + "\n", { mode: 0o600 });
const config = AccessSchema.parse({
  version: 1,
  state_directory: join(dir, "state"),
  local_principal: "owner",
  principals: [
    {
      id: "owner",
      credential_env: "INFOMANIAK_API_TOKEN",
      accounts: [account],
      access_token_sha256: digest(randomBytes(32).toString("hex")),
      approval_token_sha256: digest(human),
      operations: [...OPERATIONS.keys()],
      writes: "disposable-only",
      resources: {
        zones: { [v.zone]: { account_id: account } },
        dns_names: {
          [v.zone + ":" + NAME]: { account_id: account, disposable: true, writable: true },
        },
        mailboxes: {
          [hosting + ":" + mailbox]: { account_id: account, disposable: true, writable: true },
        },
      },
    },
  ],
});
const policyFile = join(dir, "access.local.json");
await writeFile(policyFile, JSON.stringify(config, null, 2), { mode: 0o600 });
const app = await Application.create(config, process.env);
const p = config.principals[0];
const call = (name, input) => app.dispatch(p, name, input);
const read = async (operation, args) =>
  (await call("infomaniak_read", { operation, arguments: { account_id: account, ...args } })).data;
const results = [];
const check = (label, ok) => {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) throw new Error(label);
};
const dnsArgs = { zone: v.zone },
  mailArgs = { mail_hosting_id: hosting, mailbox_name: mailbox };
const testRecords = async () =>
  (await read("dns.records.list", dnsArgs)).filter((r) => r.source === NAME);

async function step(label, operation, args) {
  const { plan } = await call("infomaniak_plan", {
    operation,
    arguments: { account_id: account, ...args },
  });
  console.log(`\n${label}\n  plan ${plan.id}\n  hash ${plan.hash}`);
  console.log(
    `  approve in another terminal:\n    node dist/admin.js approve --config ${policyFile} --id ${plan.id} --hash ${plan.hash}` +
      `\n  the human key is in ${keyFile}`,
  );
  for (;;) {
    const state = (await call("infomaniak_operation", { plan_id: plan.id })).plan.state;
    if (state === "approved") break;
    if (!["planned", "pending_approval"].includes(state)) throw new Error("plan is " + state);
    await new Promise((r) => setTimeout(r, 2000));
  }
  let { plan: done } = await call("infomaniak_execute", { plan_id: plan.id, plan_hash: plan.hash });
  for (let i = 0; i < 10 && !["verified", "failed", "unknown"].includes(done.state); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    done = (await call("infomaniak_operation", { plan_id: plan.id, refresh: true })).plan;
  }
  check(label + " verified by readback", done.state === "verified");
}

try {
  const zoneBefore = await read("dns.records.list", dnsArgs);
  const aliasesBefore = await read("mail.aliases.list", mailArgs);
  check(
    "no leftover test record or alias",
    !zoneBefore.some((r) => r.source === NAME) && !aliasesBefore.aliases.includes(ALIAS),
  );
  let denied = false;
  try {
    await call("infomaniak_plan", {
      operation: "dns.record.create",
      arguments: {
        account_id: account,
        ...dnsArgs,
        source: "www",
        type: "TXT",
        target: "x",
        ttl: 300,
      },
    });
  } catch (e) {
    denied = e.code === "access_denied" || e.code === "writes_disabled";
  }
  check("a name outside the disposable grant cannot be planned", denied);

  const txt = {
    ...dnsArgs,
    source: NAME,
    type: "TXT",
    target: "infomaniak-ai qualification",
    ttl: 300,
  };
  await step("create TXT " + NAME, "dns.record.create", txt);
  const [created] = await testRecords();
  check(
    "record exists with the planned value",
    created?.ttl === 300 && created.target.includes("qualification"),
  );
  await step("update TXT target and TTL", "dns.record.update", {
    ...dnsArgs,
    record_id: created.id,
    expected_source: NAME,
    target: "infomaniak-ai qualification 2",
    ttl: 600,
  });
  const [updated] = await testRecords();
  check("record updated", updated?.ttl === 600 && updated.target.includes("qualification 2"));
  await step("delete TXT", "dns.record.delete", {
    ...dnsArgs,
    record_id: created.id,
    expected_source: NAME,
  });
  check("record gone", (await testRecords()).length === 0);

  await step("add alias " + ALIAS, "mail.alias.add", { ...mailArgs, alias: ALIAS });
  check("alias present", (await read("mail.aliases.list", mailArgs)).aliases.includes(ALIAS));
  await step("delete alias", "mail.alias.delete", { ...mailArgs, alias: ALIAS });

  const strip = (rows) => JSON.stringify(rows.map(({ id, ...r }) => r));
  check(
    "zone identical to before",
    strip(await read("dns.records.list", dnsArgs)) === strip(zoneBefore),
  );
  check(
    "aliases identical to before",
    JSON.stringify(await read("mail.aliases.list", mailArgs)) === JSON.stringify(aliasesBefore),
  );
  console.log(`\n${results.length}/${results.length} checks passed.`);
} catch (error) {
  console.error(`\nStopped: ${error.message}`);
  console.error(
    `Check for leftovers: a TXT record named ${NAME} in ${v.zone} and the alias ${ALIAS}. ` +
      "Removing them is another approved change.",
  );
  process.exitCode = 1;
} finally {
  await app.close();
}
