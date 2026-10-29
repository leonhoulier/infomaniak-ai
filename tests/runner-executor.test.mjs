import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { RunnerExecutor, RunnerConfig } from "../dist/runner-executor.js";
import { AppDefinition, signed, validSignature } from "../dist/runner-contract.js";

async function fixture(t, proxy = "nginx") {
  const dir = await mkdtemp(join(tmpdir(), "ik-runner-fixture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519"),
    runner = randomUUID(),
    app = AppDefinition.parse({
      name: "canary",
      repository: "https://github.com/example/canary.git",
      hostname: "canary.example.com",
    });
  const config = RunnerConfig.parse({
    version: 1,
    origin: "https://hosted.example/",
    privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    runner,
    workspace: dir,
    proxy,
    privileged: false,
    nginx_directory: join(dir, "nginx"),
    acme_directory: join(dir, "acme"),
    apps: [{ ...app, ...(proxy === "external" ? { external_port: 40001 } : {}) }],
  });
  await mkdir(config.nginx_directory);
  const state = { sequence: 0, apps: {}, jobs: {} },
    calls = [],
    containers = new Map();
  let persists = 0,
    commit = "a".repeat(40),
    port = 40000,
    lastRevision,
    buildFailure = false,
    candidateFailure = false,
    badPort = false,
    publicFailures = 0;
  const command = async (binary, args) => {
    calls.push({ binary, args });
    if (binary === "git" && args.includes("clone")) {
      await mkdir(args.at(-1), { recursive: true });
      await writeFile(join(args.at(-1), "Dockerfile"), "FROM scratch\n");
    }
    if (binary === "git" && args.includes("rev-parse")) return commit;
    if (binary === "docker" && args[0] === "build" && buildFailure)
      throw new Error("fixture build failure");
    if (binary === "docker" && args[0] === "image") return "sha256:" + commit.padEnd(64, "0");
    if (binary === "docker" && args[0] === "network" && args[1] === "inspect")
      throw new Error("fixture network absent");
    if (binary === "docker" && args[0] === "run") {
      port = proxy === "external" ? 40001 : port + 1;
      containers.set(args[args.indexOf("--name") + 1], {
        Image: args.at(-1),
        Config: {
          Labels: Object.fromEntries(
            args.flatMap((a, i) =>
              a === "--label" ? [args[i + 1].split(/=(.*)/s).slice(0, 2)] : [],
            ),
          ),
        },
        NetworkSettings: {
          Ports: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }] },
        },
      });
    }
    if (binary === "docker" && args[0] === "port")
      return badPort ? "0.0.0.0:9999" : "127.0.0.1:" + port;
    if (binary === "docker" && args[0] === "container" && args[1] === "ls")
      return containers.has(args[args.indexOf("--filter") + 1].slice(7, -1))
        ? "fixture-owned-container"
        : "";
    if (binary === "docker" && args[0] === "container" && args[1] === "inspect") {
      const c = containers.get(args.at(-1));
      return JSON.stringify(args.includes("{{json .Config.Labels}}") ? c.Config.Labels : c);
    }
    if (binary === "docker" && args[0] === "rm") containers.delete(args.at(-1));
    if (binary === "nginx" && args[0] === "-T")
      return "# configuration file /etc/nginx/nginx.conf:\nserver { server_name existing.example.com; }";
    if (binary === "install" && args[0] !== "-d") {
      const source = args[2],
        target = args[3];
      const content = await readFile(source, "utf8");
      await writeFile(target, content);
      lastRevision = /X-Infomaniak-Release ([a-f0-9]+)/.exec(content)?.[1];
    }
    if (binary === "rm") await rm(args.at(-1), { force: true });
    return "";
  };
  const probe = async (url) =>
    new Response("ok", {
      status:
        (candidateFailure && String(url).includes(String(port))) ||
        (String(url).startsWith("https:") && publicFailures-- > 0)
          ? 503
          : 200,
      headers: { "x-infomaniak-release": lastRevision ?? "" },
    });
  const executor = new RunnerExecutor(
    config,
    state,
    async () => {
      persists++;
    },
    command,
    probe,
    async () => {},
  );
  const job = (action = "deploy", revision = commit) => ({
    id: randomUUID(),
    runner,
    app: app.name,
    action,
    revision,
    definition: app,
    expires: Date.now() + 600000,
  });
  return {
    executor,
    config,
    state,
    calls,
    keys,
    job,
    containers,
    get persists() {
      return persists;
    },
    setCommit(v) {
      commit = v;
    },
    failBuild() {
      buildFailure = true;
    },
    failCandidate() {
      candidateFailure = true;
    },
    failPort() {
      badPort = true;
    },
    failPublic(count) {
      publicFailures = count;
    },
  };
}
test("runner jobs require the pinned gateway signature and exact configured repository/app", async (t) => {
  const f = await fixture(t),
    job = f.job(),
    signature = signed(job, f.config.privateKey);
  assert(validSignature(job, signature, f.config.publicKey));
  assert(!validSignature({ ...job, revision: "b".repeat(40) }, signature, f.config.publicKey));
  assert.equal(
    (
      await f.executor.run({
        ...job,
        definition: { ...job.definition, repository: "https://evil.example/repo.git" },
      })
    ).code,
    "config_mismatch",
  );
  assert.equal(f.calls.length, 0);
});
test("public routing waits for the proxy reload and removes its own route when the first deployment fails", async (t) => {
  const slow = await fixture(t);
  slow.failPublic(2);
  assert.equal((await slow.executor.run(slow.job())).state, "verified");
  const failed = await fixture(t);
  failed.failPublic(100);
  const result = await failed.executor.run(failed.job());
  assert.equal(result.state, "failed");
  assert.equal(result.code, "proxy_failed");
  assert.equal(failed.containers.size, 0);
  await assert.rejects(
    readFile(
      join(
        failed.config.nginx_directory,
        "infomaniak-runner-" + failed.config.runner.slice(0, 8) + "-canary.conf",
      ),
    ),
    { code: "ENOENT" },
  );
  assert.equal(failed.state.apps.canary.uncertain, false);
});
test("runner deploys pinned commits, verifies TLS routing and rolls back to the retained image without rebuilding", async (t) => {
  const f = await fixture(t),
    first = f.job();
  assert.equal((await f.executor.run(first)).state, "verified");
  assert(f.persists >= 2);
  const image = f.state.apps.canary.current.image;
  f.setCommit("b".repeat(40));
  assert.equal((await f.executor.run(f.job())).state, "verified");
  const builds = f.calls.filter((c) => c.binary === "docker" && c.args[0] === "build").length;
  const rollback = await f.executor.run(f.job("rollback", "a".repeat(40)));
  assert.equal(rollback.state, "verified");
  assert.equal(f.state.apps.canary.current.image, image);
  assert.equal(
    f.calls.filter((c) => c.binary === "docker" && c.args[0] === "build").length,
    builds,
  );
  const count = f.calls.length;
  assert.deepEqual(await f.executor.run(first), {
    id: first.id,
    app: "canary",
    state: "verified",
    code: "ok",
  });
  assert.equal(f.calls.length, count);
});
test("runner build and candidate health failures preserve the previous live release", async (t) => {
  for (const fault of ["build", "health"]) {
    const f = await fixture(t);
    assert.equal((await f.executor.run(f.job())).state, "verified");
    const before = structuredClone(f.state.apps.canary.current);
    f.setCommit("b".repeat(40));
    if (fault === "build") f.failBuild();
    else f.failCandidate();
    const result = await f.executor.run(f.job());
    assert.equal(result.state, "failed");
    assert.deepEqual(f.state.apps.canary.current, before);
    assert.equal(f.state.apps.canary.uncertain, false);
  }
});
test("runner never repeats an interrupted or expired job", async (t) => {
  const f = await fixture(t),
    job = f.job();
  f.state.jobs[job.id] = { state: "running", job };
  const result = await f.executor.run(job);
  assert.equal(result.state, "unknown");
  assert.equal(f.state.apps.canary.uncertain, true);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.executor.run({ ...f.job(), expires: Date.now() - 1 })).code, "expired");
  assert.equal(f.calls.length, 0);
});
test("a partial launch is removed using ownership labels and the external previous release is restarted", async (t) => {
  const f = await fixture(t, "external");
  assert.equal((await f.executor.run(f.job())).state, "verified");
  const before = structuredClone(f.state.apps.canary.current);
  f.setCommit("b".repeat(40));
  f.failPort();
  const result = await f.executor.run(f.job());
  assert.equal(result.state, "failed");
  assert.deepEqual(f.state.apps.canary.current, before);
  assert.equal(f.containers.size, 1);
  assert(
    f.calls.some(
      (c) => c.binary === "docker" && c.args[0] === "start" && c.args[1] === before.container,
    ),
  );
});
test("interrupted releases reconcile through owned-container reads and TLS health without repeating commands", async (t) => {
  const f = await fixture(t),
    job = f.job();
  assert.equal((await f.executor.run(job)).state, "verified");
  f.state.jobs[job.id] = { state: "running", job };
  await f.executor.markInterrupted();
  assert.equal(f.state.jobs[job.id].result.state, "unknown");
  const start = f.calls.length;
  const result = await f.executor.reconcile(job.id);
  assert.equal(result.state, "verified");
  assert.equal(f.state.apps.canary.uncertain, false);
  assert(
    f.calls
      .slice(start)
      .every(
        (c) =>
          c.binary === "docker" &&
          c.args[0] === "container" &&
          ["ls", "inspect"].includes(c.args[1]),
      ),
  );
  assert.equal(f.state.jobs[job.id].acknowledged, false);
});
