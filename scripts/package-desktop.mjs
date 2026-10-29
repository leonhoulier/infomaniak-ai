import { mkdtemp, cp, readFile, writeFile, mkdir, readdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { zipSync } from "fflate";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const root = resolve("."),
  stage = await mkdtemp(join(tmpdir(), "infomaniak-desktop-build-"));
try {
  const manifest = JSON.parse(await readFile("desktop/manifest.json", "utf8"));
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  if (manifest.version !== pkg.version)
    throw new Error("Desktop manifest version differs from package");
  const validator = new Ajv({ strict: false, allErrors: true });
  addFormats(validator);
  const schema = JSON.parse(await readFile("desktop/mcpb-manifest.schema.json", "utf8"));
  if (!validator.validate(schema, manifest))
    throw new Error("Invalid desktop manifest: " + JSON.stringify(validator.errors));
  for (const name of ["package.json", "package-lock.json", "LICENSE", "dist", "data"])
    await cp(join(root, name), join(stage, name), { recursive: true });
  await writeFile(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
  const install = spawnSync(
    "npm",
    ["ci", "--prefix", stage, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: stage, encoding: "utf8", shell: false },
  );
  if (install.status !== 0) throw new Error("Could not prepare the desktop runtime dependencies");
  await access(join(stage, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js"));
  const files = {};
  let total = 0;
  async function collect(folder, prefix = "") {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name === ".bin") continue;
      const name = prefix + entry.name;
      if (entry.isDirectory()) await collect(join(folder, entry.name), name + "/");
      else if (entry.isFile()) {
        const content = await readFile(join(folder, entry.name));
        total += content.length;
        if (total > 128_000_000) throw new Error("Desktop runtime exceeds the build budget");
        files[name] = content;
      } else throw new Error("Unexpected link in desktop runtime");
    }
  }
  await collect(stage);
  await mkdir("artifacts", { recursive: true });
  const output = "artifacts/infomaniak-ai-" + pkg.version + ".mcpb";
  await writeFile(output, zipSync(files, { level: 9 }));
  console.log(
    "Built " +
      output +
      " with bundled runtime dependencies. Unsigned; native installation still needs client validation.",
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
