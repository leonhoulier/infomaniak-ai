import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { z } from "zod";

import { PluginError } from "./errors.js";

const SettingsSchema = z.object({
  INFOMANIAK_API_TOKEN: z.string().min(20),
  INFOMANIAK_MCP_SERVER_PATH: z.string().min(1).refine(isAbsolute),
  INFOMANIAK_MCP_SHA256: z.string().regex(/^[a-f\d]{64}$/i),
});

export type Settings = z.infer<typeof SettingsSchema>;

/** Validate configuration without including secret values in diagnostics. */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const result = SettingsSchema.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path[0]))].join(", ");
    throw new PluginError(
      "configuration_required",
      `Configure valid values for: ${fields}. Keep tokens in your client's secret store or environment.`,
    );
  }
  return result.data;
}

/** Verify an explicitly trusted backend build before starting a child process. */
export async function verifyBackend(settings: Settings): Promise<string> {
  let path: string;
  let digest: string;
  try {
    path = await realpath(settings.INFOMANIAK_MCP_SERVER_PATH);
    const info = await stat(path);
    if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error("Invalid adapter file");
    digest = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch {
    throw new PluginError(
      "backend_unavailable",
      "The configured backend build is missing, unreadable or invalid.",
    );
  }
  if (digest !== settings.INFOMANIAK_MCP_SHA256.toLowerCase()) {
    throw new PluginError(
      "backend_changed",
      "The backend build does not match its approved SHA-256. Review the new build before updating the pin.",
    );
  }
  return path;
}

/** Pass only the provider token and fixed adapter controls, never unrelated credentials. */
export function backendEnvironment(settings: Settings): Record<string, string> {
  return {
    INFOMANIAK_API_TOKEN: settings.INFOMANIAK_API_TOKEN,
    INFOMANIAK_AUTH_MODE: "disabled",
    INFOMANIAK_READ_ONLY: "1",
    LOG_LEVEL: "silent",
  };
}
