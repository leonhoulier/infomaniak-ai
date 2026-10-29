import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, realpath, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile),
  cli = resolve("dist/server.js");
const call = (args) =>
  exec(process.execPath, [cli, "runner", ...args], {
    env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
    timeout: 10000,
  });
test("runner initialization stores a private identity outside Git and never replaces it", async (t) => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "ik-runner-cli-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, "identity");
  const args = [
    "init",
    "--directory",
    directory,
    "--name",
    "canary",
    "--repository",
    "https://github.com/example/canary.git",
    "--hostname",
    "canary.example.com",
    "--proxy",
    "external",
    "--port",
    "49000",
  ];
  const created = await call(args);
  assert(!created.stdout.includes("PRIVATE KEY"));
  const file = join(directory, "runner.json"),
    before = await readFile(file, "utf8"),
    config = JSON.parse(before);
  assert(config.privateKey.startsWith("-----BEGIN PRIVATE KEY"));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(call(args));
  assert.equal(await readFile(file, "utf8"), before);
  const help = await call(["--help"]);
  assert.match(help.stdout, /runner reconcile/);
  assert(!help.stdout.includes(config.privateKey));
});
test("a damaged runner journal does not leave a process lock behind", async (t) => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "ik-runner-lock-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, "identity");
  await call([
    "init",
    "--directory",
    directory,
    "--name",
    "canary",
    "--repository",
    "https://github.com/example/canary.git",
    "--hostname",
    "canary.example.com",
    "--proxy",
    "external",
    "--port",
    "49000",
  ]);
  const file = join(directory, "runner.json"),
    config = JSON.parse(await readFile(file, "utf8"));
  config.runner = randomUUID();
  config.gatewayKey = config.publicKey;
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  await writeFile(join(directory, "state.json"), "fixture malformed journal", { mode: 0o600 });
  await assert.rejects(call(["run", "--directory", directory]));
  await assert.rejects(stat(join(directory, "runner.lock")), { code: "ENOENT" });
});
