import { readFile, mkdir, writeFile, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";

const root = new URL("../", import.meta.url),
  plugin = new URL("plugins/infomaniak/", root);
const packageInfo = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const manifest = JSON.parse(await readFile(new URL("plugin.json", plugin), "utf8"));
const claude = JSON.parse(await readFile(new URL(".claude-plugin/plugin.json", plugin), "utf8"));
if (manifest.version !== packageInfo.version || claude.version !== manifest.version)
  throw new Error("Plugin and runtime versions must match before packaging.");
const files = [
  "plugin.json",
  "mcp.json",
  ".claude-plugin/plugin.json",
  ".mcp.json",
  "README.md",
  "skills/connect/SKILL.md",
  "skills/infomaniak/SKILL.md",
  "assets/icon.png",
];
const contents = {};
for (const name of files.sort()) {
  const info = await lstat(new URL(name, plugin));
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Plugin inputs must be regular files.");
  const bytes = await readFile(new URL(name, plugin));
  if (bytes.length > 128000) throw new Error("Plugin file exceeds the package budget.");
  contents[name] = [new Uint8Array(bytes), { mtime: new Date(2026, 0, 1) }];
}
contents["LICENSE"] = [
  new Uint8Array(await readFile(new URL("LICENSE", root))),
  { mtime: new Date(2026, 0, 1) },
];
const directory = new URL("artifacts/", root);
await mkdir(directory, { recursive: true });
for (const variant of ["portable", "openai"]) {
  const input = { ...contents };
  if (variant === "openai") {
    const mcp = JSON.parse(await readFile(new URL("mcp.json", plugin), "utf8"));
    const auth = JSON.parse(await readFile(new URL("registry/openai-auth.json", root), "utf8"));
    mcp.mcpServers.infomaniak.extensions = { "com.openai": { auth } };
    input["mcp.json"] = [
      new TextEncoder().encode(JSON.stringify(mcp, null, 2) + "\n"),
      { mtime: new Date(2026, 0, 1) },
    ];
  }
  const bytes = zipSync(input, { level: 9 }),
    name = `infomaniak-plugin-${variant}-${manifest.version}.zip`;
  await writeFile(new URL(name, directory), bytes);
  const proof = {
    filename: name,
    variant,
    version: manifest.version,
    bytes: bytes.length,
    files: Object.keys(input).length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  await writeFile(new URL(name + ".json", directory), JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify({ ...proof, path: fileURLToPath(new URL(name, directory)) }));
}
