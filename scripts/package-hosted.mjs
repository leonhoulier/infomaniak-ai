import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Explicit package file allowlist lives in package.json. Assets stay outside
// that list so a subsequent build never packs a previous download recursively.
const root = resolve(import.meta.dirname, ".."),
  directory = resolve(root, "release-assets");
await mkdir(directory, { recursive: true });
const output = JSON.parse(
  execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", directory],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ),
);
const item = Array.isArray(output) ? output[0] : output["infomaniak-ai"];
if (!item || !/^infomaniak-ai-\d+\.\d+\.\d+\.tgz$/.test(item.filename))
  throw new Error("Unexpected package output");
const bytes = await readFile(resolve(directory, item.filename));
const manifest = {
  version: item.version,
  filename: item.filename,
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
};
await writeFile(resolve(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(
  JSON.stringify({
    version: manifest.version,
    bytes: manifest.bytes,
    file_count: item.files.length,
    sha256: manifest.sha256,
  }),
);
