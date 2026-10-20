import { readFile } from "node:fs/promises";
import { z } from "zod";
import { PluginError } from "./errors.js";
const Entry = z
  .object({
    id: z.string().regex(/^api\.[a-f0-9]{20}$/),
    product: z.string().max(100),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
    path: z.string().startsWith("/").max(1000),
    summary: z.string().max(500),
    documentation: z.string().url(),
  })
  .strict();
const CatalogueSchema = z
  .object({
    source: z.literal("https://developer.infomaniak.com/docs/api"),
    checked_at: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    operations: z.array(Entry).max(10_000),
  })
  .strict();
export type CatalogueEntry = z.infer<typeof Entry>;
export type ApiCatalogue = z.infer<typeof CatalogueSchema>;
export async function loadCatalogue(): Promise<ApiCatalogue> {
  const data = CatalogueSchema.parse(
    JSON.parse(await readFile(new URL("../data/catalogue.json", import.meta.url), "utf8")),
  );
  if (
    new Set(data.operations.map((r) => r.id)).size !== data.operations.length ||
    new Set(data.operations.map((r) => r.method + " " + r.path)).size !== data.operations.length
  )
    throw new PluginError("invalid_catalogue", "Duplicate public catalogue entries.");
  return data;
}
