import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, rename, open, lstat, rm, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { AppDefinition, Job, type AppState, type JobResult } from "./runner-contract.js";
import { canonical } from "./registry.js";
import { PluginError, redact } from "./errors.js";

const execute = promisify(execFile);
export const RunnerConfig = z
  .object({
    version: z.literal(1),
    origin: z
      .string()
      .url()
      .refine((v) => {
        const u = new URL(v);
        return (
          u.protocol === "https:" &&
          u.pathname === "/" &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash
        );
      }),
    privateKey: z.string().max(300),
    publicKey: z.string().max(300),
    runner: z.string().uuid().optional(),
    gatewayKey: z.string().max(300).optional(),
    workspace: z.string().refine(isAbsolute),
    proxy: z.enum(["nginx", "external"]).default("external"),
    nginx_directory: z.string().refine(isAbsolute).default("/etc/nginx/conf.d"),
    privileged: z.boolean().default(true),
    acme_directory: z
      .string()
      .regex(/^\/[A-Za-z0-9_./-]+$/)
      .default("/var/lib/infomaniak-runner-acme"),
    apps: z
      .array(
        AppDefinition.extend({
          env_file: z.string().refine(isAbsolute).optional(),
          external_port: z.number().int().min(1024).max(65535).optional(),
        }).strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();
export type RunnerConfig = z.infer<typeof RunnerConfig>;
export interface LocalRelease {
  container: string;
  image: string;
  revision: string;
  port: number;
}
export interface LocalState {
  sequence: number;
  apps: Record<string, { current?: LocalRelease; previous?: LocalRelease; uncertain?: boolean }>;
  jobs: Record<
    string,
    {
      state: "running" | "finished";
      result?: JobResult;
      job?: Job;
      candidate?: LocalRelease;
      acknowledged?: boolean;
    }
  >;
}
export type Invoke = (binary: string, args: string[], timeout?: number) => Promise<string>;
export const invoke: Invoke = async (binary, args, timeout = 600000) => {
  const { stdout, stderr } = await execute(binary, args, {
    timeout,
    maxBuffer: 256000,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/",
      LANG: "C.UTF-8",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      DOCKER_HOST: "unix:///var/run/docker.sock",
    },
  });
  return stdout + stderr;
};
export async function privateJson<T>(file: string): Promise<T> {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
  )
    throw new PluginError(
      "unsafe_runner_storage",
      "Runner configuration and state must be private regular files owned by this user.",
    );
  return JSON.parse(await readFile(file, "utf8")) as T;
}
export async function durableJson(file: string, value: unknown): Promise<void> {
  const temp = file + ".new",
    handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
}
export class RunnerExecutor {
  constructor(
    readonly config: RunnerConfig,
    readonly state: LocalState,
    private persist: () => Promise<void>,
    private command: Invoke = invoke,
    private probe: typeof fetch = fetch,
    private pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}
  private async secrets(file?: string): Promise<string[]> {
    if (!file) return [];
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.()
    )
      throw new PluginError(
        "unsafe_runner_storage",
        "The app environment file must be private, regular and owned by this user.",
      );
    return (await readFile(file, "utf8"))
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => l.slice(l.indexOf("=") + 1))
      .filter((v) => v.length >= 4);
  }
  private async healthy(url: string, revision?: string): Promise<boolean> {
    try {
      const r = await this.probe(url, {
        redirect: "error",
        headers: { connection: "close" },
        signal: AbortSignal.timeout(3000),
      });
      const ok = r.ok && (!revision || r.headers.get("x-infomaniak-release") === revision);
      await r.body?.cancel();
      return ok;
    } catch {
      return false;
    }
  }
  async inspect(): Promise<Record<string, AppState>> {
    const output: Record<string, AppState> = {};
    for (const definition of this.config.apps) {
      const state = this.state.apps[definition.name],
        current = state?.current;
      output[definition.name] = {
        revision: current?.revision ?? null,
        previous_revision: state?.previous?.revision ?? null,
        healthy: Boolean(
          current &&
          (await this.healthy("http://127.0.0.1:" + current.port + definition.health_path)) &&
          (this.config.proxy !== "nginx" ||
            (await this.healthy(
              "https://" + definition.hostname + definition.health_path,
              current.revision,
            ))),
        ),
        uncertain: state?.uncertain ?? false,
        health_scope: this.config.proxy === "nginx" ? "public-tls" : "loopback",
        updated_at: Date.now(),
        url: "https://" + definition.hostname,
      };
    }
    return output;
  }
  async markInterrupted(): Promise<void> {
    let changed = false;
    for (const [id, saved] of Object.entries(this.state.jobs))
      if (saved.state === "running" && saved.job) {
        const job = saved.job;
        if (job.action === "logs") {
          saved.state = "finished";
          saved.result = {
            id,
            app: job.app,
            state: "verified",
            code: "logs",
            logs: "The log request was interrupted. Request a fresh snapshot.",
          };
          saved.acknowledged = false;
          changed = true;
          continue;
        }
        this.state.apps[job.app] ??= {};
        this.state.apps[job.app]!.uncertain = true;
        saved.state = "finished";
        saved.result = { id, app: job.app, state: "unknown", code: "runner_interrupted" };
        saved.acknowledged = false;
        changed = true;
      }
    if (changed) await this.persist();
  }
  // Reconciliation only reads Docker and health endpoints. It never rebuilds,
  // restarts or switches a route after an interrupted deployment.
  async reconcile(id: string): Promise<JobResult> {
    const saved = this.state.jobs[id],
      job = saved?.job;
    if (!saved || !job || saved.result?.state !== "unknown")
      throw new PluginError(
        "invalid_state",
        "Choose an interrupted local job that needs reconciliation.",
      );
    const app = this.config.apps.find((a) => a.name === job.app);
    if (!app)
      throw new PluginError("config_mismatch", "The interrupted app is no longer configured.");
    const candidate = await this.findCandidate(job, app),
      before = this.state.apps[job.app]?.current;
    const publicHealthy = async (release: LocalRelease) =>
      (await this.healthy("http://127.0.0.1:" + release.port + app.health_path)) &&
      (this.config.proxy !== "nginx" ||
        (await this.healthy("https://" + app.hostname + app.health_path, release.revision)));
    let result = saved.result;
    if (candidate && (await publicHealthy(candidate))) {
      this.state.apps[job.app] = {
        current: candidate,
        ...(before && before.container !== candidate.container
          ? { previous: before }
          : this.state.apps[job.app]?.previous
            ? { previous: this.state.apps[job.app]!.previous }
            : {}),
        uncertain: false,
      };
      result = { id, app: job.app, state: "verified", code: "ok" };
    } else if (!candidate && (!before || (await publicHealthy(before)))) {
      if (!before && this.config.proxy === "nginx") {
        const destination = join(
          this.config.nginx_directory,
          "infomaniak-runner-" + this.config.runner!.slice(0, 8) + "-" + app.name + ".conf",
        );
        try {
          await lstat(destination);
          return result;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      this.state.apps[job.app] ??= {};
      this.state.apps[job.app]!.uncertain = false;
      result = { id, app: job.app, state: "failed", code: "runner_interrupted" };
    }
    saved.result = result;
    saved.acknowledged = false;
    await this.persist();
    return result;
  }
  private containerName(job: Job): string {
    return (
      "ik-runner-" + this.config.runner!.slice(0, 8) + "-" + job.app + "-" + job.id.slice(0, 8)
    );
  }
  private async findCandidate(
    job: Job,
    app: RunnerConfig["apps"][number],
  ): Promise<LocalRelease | undefined> {
    const container = this.containerName(job),
      ids = (
        await this.command(
          "docker",
          [
            "container",
            "ls",
            "--all",
            "--filter",
            "name=^/" + container + "$",
            "--format",
            "{{.ID}}",
          ],
          10000,
        )
      ).trim();
    if (!ids) return;
    const raw = JSON.parse(
      await this.command(
        "docker",
        ["container", "inspect", "--format", "{{json .}}", container],
        10000,
      ),
    ) as {
      Image: string;
      Config: { Labels?: Record<string, string> };
      NetworkSettings: { Ports?: Record<string, { HostIp: string; HostPort: string }[] | null> };
    };
    const labels = raw.Config.Labels,
      port = raw.NetworkSettings.Ports?.[app.container_port + "/tcp"];
    if (
      !labels ||
      labels["io.infomaniak.runner"] !== this.config.runner ||
      labels["io.infomaniak.app"] !== job.app ||
      labels["io.infomaniak.job"] !== job.id ||
      labels["io.infomaniak.revision"] !== job.revision ||
      !/^sha256:[a-f0-9]{64}$/.test(raw.Image)
    )
      throw new Error("Candidate ownership does not match this job");
    if (port?.length !== 1 || port[0]?.HostIp !== "127.0.0.1" || !/^[0-9]+$/.test(port[0].HostPort))
      throw new Error("Candidate port is not isolated");
    const number = Number(port[0].HostPort);
    if (
      number < 1024 ||
      number > 65535 ||
      (this.config.proxy === "external" && number !== app.external_port)
    )
      throw new Error("Candidate port does not match configuration");
    return { container, image: raw.Image, revision: job.revision!, port: number };
  }
  private async removeCandidate(job: Job): Promise<void> {
    const container = this.containerName(job),
      ids = (
        await this.command(
          "docker",
          [
            "container",
            "ls",
            "--all",
            "--filter",
            "name=^/" + container + "$",
            "--format",
            "{{.ID}}",
          ],
          10000,
        )
      ).trim();
    if (!ids) return;
    const labels = JSON.parse(
      await this.command(
        "docker",
        ["container", "inspect", "--format", "{{json .Config.Labels}}", container],
        10000,
      ),
    ) as Record<string, string>;
    if (
      labels["io.infomaniak.runner"] !== this.config.runner ||
      labels["io.infomaniak.app"] !== job.app ||
      labels["io.infomaniak.job"] !== job.id
    )
      throw new Error("Refusing to remove a foreign container");
    await this.command("docker", ["rm", "--force", container], 30000);
  }
  async run(raw: Job): Promise<JobResult> {
    const job = Job.parse(raw),
      configured = this.config.apps.find((a) => a.name === job.app);
    const definition =
      configured &&
      (({ env_file: _, external_port: __, ...publicDefinition }) => publicDefinition)(configured);
    if (
      !configured ||
      canonical(AppDefinition.parse(definition)) !== canonical(job.definition) ||
      job.runner !== this.config.runner
    )
      return { id: job.id, app: job.app, state: "failed", code: "config_mismatch" };
    const prior = this.state.jobs[job.id];
    if (prior) {
      if (prior.result) return prior.result;
      this.state.apps[job.app] ??= {};
      this.state.apps[job.app]!.uncertain = true;
      const result: JobResult = {
        id: job.id,
        app: job.app,
        state: "unknown",
        code: "runner_interrupted",
      };
      this.state.jobs[job.id] = { ...prior, state: "finished", result, job };
      await this.persist();
      return result;
    }
    if (job.expires <= Date.now())
      return { id: job.id, app: job.app, state: "failed", code: "expired" };
    const secrets = await this.secrets(configured.env_file);
    const clean = (value: string) =>
      Buffer.from(String(redact(value, secrets)))
        .subarray(0, 6000)
        .toString("utf8");
    this.state.jobs[job.id] = { state: "running", job };
    await this.persist();
    if (job.action === "logs") {
      const active = this.state.apps[job.app]?.current;
      const logs = active
        ? await this.command("docker", ["logs", "--tail", "100", active.container], 10000).catch(
            () => "Logs unavailable.",
          )
        : "No active release.";
      const result: JobResult = {
        id: job.id,
        app: job.app,
        state: "verified",
        code: "logs",
        logs: clean(logs),
      };
      this.state.jobs[job.id] = { state: "finished", result };
      await this.persist();
      return result;
    }
    let stage: JobResult["code"] = "build_failed",
      candidate: LocalRelease | undefined;
    const previous = this.state.apps[job.app]?.current;
    try {
      if (job.action === "rollback") {
        const release = this.state.apps[job.app]?.previous;
        if (!release || release.revision !== job.revision)
          throw new Error("Previous release unavailable");
        candidate = await this.launch(job, configured, release.image);
      } else {
        const directory = join(this.config.workspace, "builds", job.id);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await this.command("git", [
          "-c",
          "protocol.file.allow=never",
          "-c",
          "protocol.ext.allow=never",
          "-c",
          "core.hooksPath=/dev/null",
          "clone",
          "--no-checkout",
          "--filter=blob:none",
          "--",
          configured.repository,
          join(directory, "repository"),
        ]);
        const repo = join(directory, "repository");
        await this.command("git", [
          "-C",
          repo,
          "-c",
          "core.hooksPath=/dev/null",
          "fetch",
          "--depth=1",
          "origin",
          job.revision!,
        ]);
        await this.command("git", [
          "-C",
          repo,
          "-c",
          "core.hooksPath=/dev/null",
          "checkout",
          "--detach",
          job.revision!,
        ]);
        if ((await this.command("git", ["-C", repo, "rev-parse", "HEAD"])).trim() !== job.revision)
          throw new Error("Commit changed");
        const context = join(repo, configured.build_context),
          root = await realpath(repo),
          contextRoot = await realpath(context),
          contextInfo = await lstat(context);
        if (
          !contextInfo.isDirectory() ||
          contextInfo.isSymbolicLink() ||
          (contextRoot !== root && !contextRoot.startsWith(root + "/"))
        )
          throw new Error("Build context must stay inside the pinned repository");
        const dockerfile = join(context, configured.dockerfile),
          info = await lstat(dockerfile);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          !(await realpath(dockerfile)).startsWith(contextRoot + "/")
        )
          throw new Error("Dockerfile must be a regular file inside the pinned build context");
        const tag = "ik-runner-" + this.config.runner!.slice(0, 8) + "-" + job.app + ":" + job.id;
        await this.command("docker", [
          "build",
          "--file",
          dockerfile,
          "--label",
          "io.infomaniak.runner=" + this.config.runner,
          "--label",
          "io.infomaniak.app=" + job.app,
          "--label",
          "io.infomaniak.revision=" + job.revision,
          "--tag",
          tag,
          "--",
          context,
        ]);
        const image = (
          await this.command("docker", ["image", "inspect", "--format", "{{.Id}}", tag])
        ).trim();
        if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Invalid image identity");
        candidate = await this.launch(job, configured, image);
      }
      this.state.jobs[job.id]!.candidate = candidate;
      await this.persist();
      stage = "health_failed";
      let ready = false;
      for (let i = 0; i < 30 && !ready; i++) {
        ready = await this.healthy("http://127.0.0.1:" + candidate.port + configured.health_path);
        if (!ready) await this.pause(1000);
      }
      if (!ready) throw new Error("Candidate health failed");
      stage = "proxy_failed";
      if (job.expires <= Date.now())
        throw new Error("The approved deployment expired before routing");
      if (this.config.proxy === "nginx") {
        await this.nginx(configured, candidate);
        let routed = false;
        for (let i = 0; i < 30 && !routed; i++) {
          routed = await this.healthy(
            "https://" + configured.hostname + configured.health_path,
            candidate.revision,
          );
          if (!routed) await this.pause(1000);
        }
        if (!routed) throw new Error("Public TLS health failed");
      }
      this.state.apps[job.app] = {
        current: candidate,
        ...(previous ? { previous } : {}),
        uncertain: false,
      };
      const result: JobResult = { id: job.id, app: job.app, state: "verified", code: "ok" };
      this.state.jobs[job.id] = { state: "finished", result, job, candidate };
      await this.persist();
      if (previous && previous.container !== candidate.container)
        await this.command("docker", ["stop", "--time", "15", previous.container], 30000).catch(
          () => undefined,
        );
      return result;
    } catch (error) {
      let recovered = true;
      await this.removeCandidate(job).catch(() => {
        recovered = false;
      });
      if (previous) {
        try {
          if (this.config.proxy === "external")
            await this.command("docker", ["start", previous.container], 30000);
          else await this.nginx(configured, previous);
          if (!(await this.healthy("http://127.0.0.1:" + previous.port + configured.health_path)))
            recovered = false;
          if (
            this.config.proxy === "nginx" &&
            !(await this.healthy(
              "https://" + configured.hostname + configured.health_path,
              previous.revision,
            ))
          )
            recovered = false;
        } catch {
          recovered = false;
        }
      }
      if (!previous && this.config.proxy === "nginx")
        await this.removeNginx(configured).catch(() => {
          recovered = false;
        });
      this.state.apps[job.app] ??= {};
      this.state.apps[job.app]!.uncertain = !recovered;
      const result: JobResult = {
        id: job.id,
        app: job.app,
        state: recovered ? "failed" : "unknown",
        code: recovered
          ? error instanceof PluginError &&
            ["hostname_conflict", "configuration_error"].includes(error.code)
            ? (error.code as "hostname_conflict" | "configuration_error")
            : stage
          : "rollback_failed",
      };
      this.state.jobs[job.id] = {
        state: "finished",
        result,
        job,
        ...(candidate ? { candidate } : {}),
      };
      await this.persist();
      return result;
    } finally {
      await rm(join(this.config.workspace, "builds", job.id), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
  }
  private async launch(
    job: Job,
    app: RunnerConfig["apps"][number],
    image: string,
  ): Promise<LocalRelease> {
    const container = this.containerName(job);
    if (this.config.proxy === "external" && !app.external_port)
      throw new Error("Configure the external proxy's loopback app port");
    const prior = this.state.apps[app.name]?.current;
    if (this.config.proxy === "external" && prior)
      await this.command("docker", ["stop", "--time", "15", prior.container], 30000);
    const network = "ik-runner-" + this.config.runner!.slice(0, 8) + "-" + app.name;
    let labels: Record<string, string> | undefined;
    try {
      labels = JSON.parse(
        await this.command(
          "docker",
          ["network", "inspect", "--format", "{{json .Labels}}", network],
          10000,
        ),
      ) as Record<string, string>;
    } catch {
      /* Create this app's isolated bridge below. */
    }
    if (
      labels &&
      (labels["io.infomaniak.runner"] !== this.config.runner ||
        labels["io.infomaniak.app"] !== app.name)
    )
      throw new Error("Foreign Docker network");
    if (!labels)
      await this.command(
        "docker",
        [
          "network",
          "create",
          "--label",
          "io.infomaniak.runner=" + this.config.runner,
          "--label",
          "io.infomaniak.app=" + app.name,
          network,
        ],
        10000,
      );
    await this.command(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        container,
        "--network",
        network,
        "--label",
        "io.infomaniak.runner=" + this.config.runner,
        "--label",
        "io.infomaniak.app=" + app.name,
        "--label",
        "io.infomaniak.job=" + job.id,
        "--label",
        "io.infomaniak.revision=" + job.revision,
        "--restart",
        "unless-stopped",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "128",
        "--tmpfs",
        "/tmp:size=64m,mode=1777",
        "--publish",
        "127.0.0.1:" +
          (this.config.proxy === "external" ? app.external_port : "") +
          ":" +
          app.container_port,
        ...(app.env_file ? ["--env-file", app.env_file] : []),
        image,
      ],
      30000,
    );
    const ports = await this.command(
        "docker",
        ["port", container, String(app.container_port)],
        10000,
      ),
      match = /^127\.0\.0\.1:([0-9]+)\s*$/.exec(ports.trim());
    if (
      !match ||
      Number(match[1]) < 1024 ||
      Number(match[1]) > 65535 ||
      (this.config.proxy === "external" && Number(match[1]) !== app.external_port)
    )
      throw new PluginError(
        "configuration_error",
        "The container port does not match its isolated loopback binding.",
      );
    return { container, image, revision: job.revision!, port: Number(match[1]) };
  }
  private async removeNginx(app: RunnerConfig["apps"][number]): Promise<void> {
    const destination = join(
        this.config.nginx_directory,
        "infomaniak-runner-" + this.config.runner!.slice(0, 8) + "-" + app.name + ".conf",
      ),
      marker = "# Infomaniak runner " + this.config.runner + " app " + app.name;
    let content: string;
    try {
      content = await readFile(destination, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!content.startsWith(marker + "\n"))
      throw new PluginError(
        "configuration_error",
        "Refusing to remove a proxy file outside this runner.",
      );
    const privileged = (command: string, args: string[]) =>
      this.config.privileged
        ? this.command("sudo", ["-n", command, ...args], 90000)
        : this.command(command, args, 90000);
    await privileged("rm", ["--", destination]);
    await privileged("nginx", ["-t"]);
    await privileged("systemctl", ["reload", "nginx"]);
  }
  private async nginx(app: RunnerConfig["apps"][number], release: LocalRelease): Promise<void> {
    const name = "infomaniak-runner-" + this.config.runner!.slice(0, 8) + "-" + app.name + ".conf",
      destination = join(this.config.nginx_directory, name),
      marker = "# Infomaniak runner " + this.config.runner + " app " + app.name;
    let before: string | undefined;
    try {
      const info = await lstat(destination);
      if (!info.isFile() || info.isSymbolicLink())
        throw new PluginError(
          "configuration_error",
          "The managed proxy route must be a regular file.",
        );
      before = await readFile(destination, "utf8");
      if (!before.startsWith(marker + "\n"))
        throw new PluginError(
          "configuration_error",
          "A proxy file exists outside this runner ownership.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const privileged = (command: string, args: string[]) =>
      this.config.privileged
        ? this.command("sudo", ["-n", command, ...args], 90000)
        : this.command(command, args, 90000);
    const all = await privileged("nginx", ["-T"]);
    const sections = all.split(/^# configuration file (.+):$/m);
    for (let i = 1; i + 1 < sections.length; i += 2) {
      if (sections[i]!.trim() === destination) continue;
      for (const match of sections[i + 1]!.matchAll(/server_name\s+([^;]+);/g))
        for (const host of match[1]!.trim().split(/\s+/))
          if (host.startsWith("~"))
            throw new PluginError(
              "hostname_conflict",
              "Regex Nginx hostnames need an explicit external-proxy configuration.",
            );
          else if (
            host === app.hostname ||
            (host.endsWith(".*") && app.hostname.startsWith(host.slice(0, -1))) ||
            (host.startsWith("*.") && app.hostname.endsWith(host.slice(1))) ||
            (host.startsWith(".") &&
              (app.hostname === host.slice(1) || app.hostname.endsWith(host)))
          )
            throw new PluginError(
              "hostname_conflict",
              "The hostname is already routed outside this runner.",
            );
    }
    const directory = join(this.config.workspace, "proxy"),
      source = join(directory, name),
      acme = join(this.config.acme_directory, this.config.runner!);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await privileged("install", ["-d", "-m", "0755", acme]);
    const http = `${marker}\nserver { listen 80; server_name ${app.hostname}; location ^~ /.well-known/acme-challenge/ { root ${acme}; } location / { return 301 https://$host$request_uri; } }\n`;
    const install = async (content: string) => {
      await writeFile(source, content, { mode: 0o600 });
      await privileged("install", ["-m", "0644", source, destination]);
      await privileged("nginx", ["-t"]);
      await privileged("systemctl", ["reload", "nginx"]);
    };
    try {
      if (!before) {
        await install(http);
        await privileged("certbot", [
          "certonly",
          "--webroot",
          "--webroot-path",
          acme,
          "--non-interactive",
          "--keep-until-expiring",
          "-d",
          app.hostname,
        ]);
      }
      await install(
        http +
          `server { listen 443 ssl; server_name ${app.hostname}; ssl_certificate /etc/letsencrypt/live/${app.hostname}/fullchain.pem; ssl_certificate_key /etc/letsencrypt/live/${app.hostname}/privkey.pem; ssl_protocols TLSv1.2 TLSv1.3; location / { proxy_pass http://127.0.0.1:${release.port}; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; add_header X-Infomaniak-Release ${release.revision} always; } }\n`,
      );
    } catch (error) {
      if (before) await install(before);
      else {
        await privileged("rm", ["--", destination]);
        await privileged("nginx", ["-t"]);
        await privileged("systemctl", ["reload", "nginx"]);
      }
      throw error;
    } finally {
      await rm(source, { force: true });
    }
  }
}
