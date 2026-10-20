import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
await mkdir("artifacts", { recursive: true });
const result = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", "artifacts"], {
  stdio: "inherit",
  shell: false,
});
process.exitCode = result.status ?? 1;
