import { parseArgs } from "node:util";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { mkdir, lstat, realpath, open, rm } from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";
import { cpus, totalmem, freemem, uptime, loadavg } from "node:os";
import {
  RunnerConfig,
  RunnerExecutor,
  privateJson,
  durableJson,
  type LocalState,
} from "./runner-executor.js";
import { Report, Job, signed, validSignature, type JobResult } from "./runner-contract.js";
import { PluginError } from "./errors.js";

const emptyState = (): LocalState => ({ sequence: 0, apps: {}, jobs: {} });
async function call(
  origin: string,
  path: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  if (text.length > 128000 || !response.ok)
    throw new PluginError(
      "runner_connection_failed",
      "Runner connection failed. Check the server, pairing and connection permissions.",
    );
  return JSON.parse(text) as Record<string, unknown>;
}
async function safeDirectory(directory: string): Promise<void> {
  if (!isAbsolute(directory) || directory === "/")
    throw new PluginError(
      "invalid_configuration",
      "Use an absolute private runner directory outside Git.",
    );
  let ancestor = directory;
  while (ancestor !== dirname(ancestor)) {
    try {
      if (
        (await lstat(join(ancestor, ".git"))).isFile() ||
        (await lstat(join(ancestor, ".git"))).isDirectory()
      )
        throw new PluginError(
          "private_location_required",
          "Keep the runner's identity, state and app environment files outside Git.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    ancestor = dirname(ancestor);
  }
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.() ||
    (await realpath(directory)) !== directory
  )
    throw new PluginError(
      "unsafe_runner_storage",
      "Use a private directory owned by this user, without directory symlinks.",
    );
}
export async function runnerCli(args: string[]): Promise<void> {
  if (!args.length || args.includes("--help")) {
    console.log(
      "Infomaniak customer-owned deployment runner\n\nOn the VPS, outside Git:\n  infomaniak-ai runner init --directory /PRIVATE/RUNNER --name APP --repository https://github.com/OWNER/REPO.git --hostname APP.example.com --proxy nginx\n  infomaniak-ai runner pair --directory /PRIVATE/RUNNER\n  infomaniak-ai runner run --directory /PRIVATE/RUNNER\n\nAfter a forced crash, stop the old process, remove only its stale runner.lock, then run:\n  infomaniak-ai runner reconcile --directory /PRIVATE/RUNNER --job JOB_UUID\nReconciliation reads Docker and health endpoints; it never repeats a deployment.\n\nRequires Node 22+, Docker and an existing Dockerfile. The nginx adapter also needs Nginx, certbot, an existing ACME account and permission to install its own proxy file/reload Nginx. Existing hostnames are refused. For an external proxy, use --proxy external --port UNUSED_LOOPBACK_PORT. App environment files stay on the VPS (--env-file PRIVATE_FILE). Stateless HTTP apps only; no database migration or arbitrary shell tool.",
    );
    return;
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      directory: { type: "string" },
      server: { type: "string" },
      name: { type: "string" },
      repository: { type: "string" },
      hostname: { type: "string" },
      proxy: { type: "string" },
      port: { type: "string" },
      dockerfile: { type: "string" },
      "build-context": { type: "string" },
      "container-port": { type: "string" },
      "health-path": { type: "string" },
      "env-file": { type: "string" },
      job: { type: "string" },
    },
  });
  const action = positionals[0],
    directory = values.directory;
  if (
    !directory ||
    !["init", "pair", "run", "reconcile"].includes(action ?? "") ||
    positionals.length !== 1
  )
    throw new PluginError(
      "invalid_option",
      "Use runner init, pair, run or reconcile with an absolute --directory.",
    );
  if (action === "init") {
    if (!isAbsolute(directory))
      throw new PluginError("invalid_configuration", "Use an absolute private directory.");
    const pair = generateKeyPairSync("ed25519"),
      config = RunnerConfig.parse({
        version: 1,
        origin: new URL(values.server ?? "https://infomaniak-mcp.com/").href,
        workspace: directory,
        privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
        proxy: values.proxy ?? "external",
        apps: [
          {
            name: values.name,
            repository: values.repository,
            hostname: values.hostname,
            dockerfile: values.dockerfile ?? "Dockerfile",
            build_context: values["build-context"] ?? ".",
            container_port: Number(values["container-port"] ?? 3000),
            health_path: values["health-path"] ?? "/",
            ...(values.port ? { external_port: Number(values.port) } : {}),
            ...(values["env-file"] ? { env_file: values["env-file"] } : {}),
          },
        ],
      });
    // Refuse an existing directory. Initialization never replaces an identity or state.
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    try {
      await safeDirectory(directory);
      await durableJson(join(directory, "runner.json"), config);
      await durableJson(join(directory, "state.json"), emptyState());
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    console.log(
      "Runner identity and state created privately. Next: runner pair --directory " + directory,
    );
    return;
  }
  await safeDirectory(directory);
  const config = RunnerConfig.parse(await privateJson(join(directory, "runner.json")));
  if (
    config.workspace !== directory ||
    createPublicKey(config.privateKey).export({ type: "spki", format: "pem" }).toString() !==
      config.publicKey
  )
    throw new PluginError(
      "invalid_configuration",
      "Runner identity or workspace does not match its configuration.",
    );
  if (action === "pair") {
    if (config.runner)
      throw new PluginError(
        "invalid_configuration",
        "This identity is already paired. Revoke it and initialise a separate private identity to pair again.",
      );
    const registered = await call(config.origin, "/runner-api/register", {
      publicKey: config.publicKey,
      apps: config.apps.map(({ env_file: _, external_port: __, ...definition }) => definition),
    });
    const request = String(registered.request),
      expires = Number(registered.expires),
      url = new URL(String(registered.pairing_url));
    if (url.origin !== new URL(config.origin).origin || url.pathname !== "/runners/pair/" + request)
      throw new PluginError(
        "runner_connection_failed",
        "The server returned an unexpected pairing address.",
      );
    console.log(
      "Open this link in the browser where you connected your AI. Review the repository, hostname and connection before pairing:\n" +
        url.href,
    );
    while (Date.now() < expires) {
      const result = await call(config.origin, "/runner-api/pair-status", {
        request,
        signature: signed({ request }, config.privateKey),
      });
      if (result.runner && result.publicKey) {
        const paired = RunnerConfig.parse({
          ...config,
          runner: result.runner,
          gatewayKey: result.publicKey,
        });
        await durableJson(join(directory, "runner.json"), paired);
        console.log("Runner paired. Start runner run with this private directory.");
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new PluginError("connection_expired", "Pairing expired. Run the pair command again.");
  }
  if (!config.runner || !config.gatewayKey)
    throw new PluginError("configuration_required", "Pair this runner before starting it.");
  const lock = join(directory, "runner.lock"),
    handle = await open(lock, "wx", 0o600).catch(() => {
      throw new PluginError(
        "state_in_use",
        "A runner lock exists. Stop that process before restarting; after a forced crash, inspect its app state before removing the stale lock.",
      );
    });
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    await handle.close();
    const state = await privateJson<LocalState>(join(directory, "state.json"));
    let writes = Promise.resolve();
    const persist = () => {
      const finished = Object.entries(state.jobs).filter(
        ([, job]) => job.acknowledged && job.result?.state !== "unknown",
      );
      for (const [id] of finished.slice(0, Math.max(0, finished.length - 200)))
        delete state.jobs[id];
      const snapshot = structuredClone(state);
      writes = writes.then(() => durableJson(join(directory, "state.json"), snapshot));
      return writes;
    };
    const executor = new RunnerExecutor(config, state, persist);
    await executor.markInterrupted();
    if (action === "reconcile") {
      try {
        if (!values.job || !/^[a-f0-9-]{36}$/.test(values.job))
          throw new PluginError(
            "invalid_option",
            "Choose a local interrupted job with --job JOB_UUID.",
          );
        const result = await executor.reconcile(values.job);
        await writes;
        console.log(JSON.stringify(result));
        return;
      } finally {
        await rm(lock, { force: true });
      }
    }
    let stopped = false,
      task: Promise<void> | undefined,
      connectionFailed = false;
    const stop = () => {
      stopped = true;
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log("Runner started. Waiting for independently approved jobs.");
    try {
      while (!stopped) {
        const pending = Object.values(state.jobs).find(
          (j) => j.result && !(j as { acknowledged?: boolean }).acknowledged,
        )?.result;
        const report = Report.parse({
          version: 1,
          apps: await executor.inspect(),
          results: pending ? [pending] : [],
          host: {
            cpus: cpus().length,
            memory_total: totalmem(),
            memory_free: freemem(),
            uptime_seconds: uptime(),
            load: loadavg(),
          },
        });
        state.sequence++;
        await persist();
        const payload = { runner: config.runner, sequence: state.sequence, report };
        try {
          const response = await call(config.origin, "/runner-api/poll", {
            ...payload,
            signature: signed(payload, config.privateKey),
          });
          if (Array.isArray(response.acknowledged))
            for (const id of response.acknowledged) {
              const saved = state.jobs[String(id)];
              if (saved) Object.assign(saved, { acknowledged: true });
            }
          await persist();
          connectionFailed = false;
          if (!task && Array.isArray(response.jobs) && response.jobs.length) {
            const envelope = response.jobs[0] as { job: unknown; signature: string };
            if (!validSignature(envelope.job, envelope.signature, config.gatewayKey))
              throw new PluginError(
                "invalid_signature",
                "A runner job failed its gateway signature check.",
              );
            const job = Job.parse(envelope.job);
            task = executor
              .run(job)
              .then(async (result: JobResult) => {
                state.jobs[job.id] = { ...state.jobs[job.id], state: "finished", result };
                await persist();
              })
              .finally(() => {
                task = undefined;
              });
            void task.catch(() => {
              stopped = true;
              console.error(
                "Runner stopped after a local state error. Inspect its journal before restarting.",
              );
            });
          }
        } catch {
          if (!connectionFailed)
            console.error(
              "Runner connection unavailable. Retrying without repeating a deployment.",
            );
          connectionFailed = true;
        }
        if (!stopped) await new Promise((r) => setTimeout(r, 8000));
      }
      if (task) await task;
      await writes;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      await rm(lock, { force: true });
    }
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lock, { force: true });
  }
}
