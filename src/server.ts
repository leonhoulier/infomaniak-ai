#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpBackend } from "./backend.js";
import { loadSettings, verifyBackend } from "./config.js";
import { loadAccess, credential, loadProviderSecret } from "./access.js";
import { PluginError } from "./errors.js";
import { Gateway } from "./gateway.js";
import { createProtocol } from "./protocol.js";

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--config");
  const path = flag >= 0 ? process.argv[flag + 1] : process.env.INFOMANIAK_POLICY_FILE?.trim();
  if (flag >= 0 && !path)
    throw new PluginError(
      "configuration_required",
      "Provide an absolute policy path after --config.",
    );
  if (path) {
    // Load the SQLite runtime only for the policy-driven edition.
    const [{ Application }, { createRemote }] = await Promise.all([
      import("./application.js"),
      import("./remote.js"),
    ]);
    const config = await loadAccess(path);
    if (process.argv.includes("--doctor")) {
      for (const p of config.principals) credential(p);
      if (config.backend)
        await verifyBackend({
          INFOMANIAK_API_TOKEN: "integrity-check-only-value",
          INFOMANIAK_MCP_SERVER_PATH: config.backend.path,
          INFOMANIAK_MCP_SHA256: config.backend.sha256,
        });
      console.log(
        JSON.stringify({
          configured: true,
          mode: "controlled-api",
          principals: config.principals.length,
          api_permissions_tested: false,
        }),
      );
      return;
    }
    const remoteOnly = process.argv.includes("--http");
    const principal = config.principals.find((p) => p.id === config.local_principal);
    if (!remoteOnly && !principal)
      throw new PluginError(
        "configuration_required",
        "Select a local_principal in the policy for stdio use.",
      );
    if (remoteOnly && !config.remote)
      throw new PluginError(
        "configuration_required",
        "Configure the remote listener and public origin.",
      );
    const app = await Application.create(config);
    const http = config.remote ? createRemote(app) : undefined;
    let closing = false;
    const protocol = remoteOnly
      ? undefined
      : createProtocol((name, args) => app.dispatch(principal!, name, args), true);
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
      if (protocol) await protocol.close();
      await app.close();
    };
    try {
      if (http)
        await new Promise<void>((resolve, reject) => {
          http.once("error", reject);
          http.listen(config.remote!.port, config.remote!.host, () => resolve());
        });
      if (protocol) {
        protocol.onclose = () => {
          void shutdown();
        };
        await protocol.connect(new StdioServerTransport());
      }
      for (const signal of ["SIGINT", "SIGTERM"] as const)
        process.once(signal, () => {
          void shutdown().finally(() => process.exit(0));
        });
    } catch (error) {
      await shutdown();
      throw error;
    }
    return;
  }
  if (process.argv.includes("--http"))
    throw new PluginError("configuration_required", "Remote use requires a private policy file.");
  if (
    !process.env.INFOMANIAK_MCP_SERVER_PATH?.trim() &&
    !process.env.INFOMANIAK_MCP_SHA256?.trim()
  ) {
    const token = loadProviderSecret("INFOMANIAK_API_TOKEN");
    if (process.argv.includes("--doctor")) {
      console.log(
        JSON.stringify({
          configured: true,
          mode: "discovery-only",
          writes_enabled: false,
          api_permissions_tested: false,
        }),
      );
      return;
    }
    const { Discovery } = await import("./discovery.js");
    const gateway = await Discovery.create(token);
    const protocol = createProtocol((name, args) => gateway.dispatch(name, args), false, true);
    await protocol.connect(new StdioServerTransport());
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        void protocol.close().finally(() => process.exit(0));
      });
    return;
  }
  const settings = loadSettings();
  if (process.argv.includes("--doctor")) {
    await verifyBackend(settings);
    console.log(
      JSON.stringify({
        configured: true,
        backend_integrity: "matched",
        browser_auth: "disabled",
        mode: "read-only",
        api_permissions_tested: false,
      }),
    );
    return;
  }
  const backend = new McpBackend(settings);
  const gateway = new Gateway(backend, [settings.INFOMANIAK_API_TOKEN]);
  const server = createProtocol((name, args, signal) => gateway.dispatch(name, args, signal));
  const shutdown = async () => {
    await backend.close();
    await server.close();
  };
  server.onclose = () => {
    void backend.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  await server.connect(new StdioServerTransport());
}
main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      error: true,
      code: error instanceof PluginError ? error.code : "startup_failed",
      message: error instanceof PluginError ? error.message : "Plugin initialization failed.",
    }),
  );
  process.exitCode = 1;
});
