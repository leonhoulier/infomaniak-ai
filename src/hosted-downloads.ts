import { readFile } from "node:fs/promises";
import type { Express } from "express";
import { z } from "zod";
import { escapeHtml as e, SOURCE } from "./hosted-pages.js";
const Manifest = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    filename: z.string().regex(/^infomaniak-ai-\d+\.\d+\.\d+\.tgz$/),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    integrity: z.string().startsWith("sha512-"),
  })
  .strict();
export function mountDownloads(
  app: Express,
  origin: URL,
  page: (title: string, body: string, path?: string) => string,
): void {
  const manifest = async () =>
    Manifest.parse(
      JSON.parse(
        await readFile(new URL("../release-assets/manifest.json", import.meta.url), "utf8"),
      ),
    );
  app.get("/releases/latest.json", async (_req, res) => {
    try {
      const m = await manifest();
      res.json({ ...m, url: new URL("/downloads/" + m.filename, origin).href });
    } catch {
      res.status(503).json({ error: "release_unavailable" });
    }
  });
  app.get("/plugins", async (_req, res) => {
    try {
      const m = await manifest(),
        release = SOURCE + "/releases/download/v" + m.version;
      res
        .type("html")
        .send(
          page(
            "Install the Infomaniak plugin",
            `<h1>Infomaniak, in your AI tools.</h1><p class="lead">An independent, MIT-licensed project. Use the hosted MCP with your own account, or contribute to the source.</p><section class="panel"><h2>Plugin ${e(m.version)}</h2><p>The package includes two skills and one hosted MCP connection. Your Infomaniak token stays out of the download.</p><div class="hero-actions"><a class="button" href="${release}/infomaniak-plugin-portable-${e(m.version)}.zip">Download portable plugin</a><a class="button secondary" href="${release}/infomaniak-plugin-openai-${e(m.version)}.zip">Download OpenAI package</a></div><p><a href="${release}/SHA256SUMS">Checksums</a> · <a href="${SOURCE}/releases/tag/v${e(m.version)}">Release notes and source</a></p><p>Public downloads are available for manual installation. These are not approved directory listings. Check <a href="/clients">client qualification</a> before choosing a client.</p></section><section class="section"><h2>Claude Code</h2><code>claude plugin marketplace add leonhoulier/infomaniak-ai\nclaude plugin install infomaniak@infomaniak-mcp</code><p>This adds our repository as an installation source. It does not imply a listing in Claude’s official directory.</p><p>Other clients can import a supported archive or add <code class="inline-code">${e(new URL("/mcp", origin).href)}</code> as a remote MCP server. <a href="/#setup">Setup guides</a>.</p></section><section class="section"><h2>Contributions welcome.</h2><p>Help with Infomaniak operations, client compatibility, documentation or regression tests. Keep changes small and test with fixtures.</p><p><a href="${SOURCE}/blob/main/CONTRIBUTING.md">Read the contribution guide</a> · <a href="${SOURCE}/issues">Report a bug or suggest a change</a></p></section>`,
            "/plugins",
          ),
        );
    } catch {
      res
        .status(503)
        .type("html")
        .send(
          page(
            "Plugins unavailable",
            "<h1>Plugin downloads are temporarily unavailable.</h1><p>Please try again shortly.</p>",
            "/plugins",
          ),
        );
    }
  });
  app.get("/downloads", async (_req, res) => {
    try {
      const m = await manifest(),
        url = new URL("/downloads/" + m.filename, origin).href;
      res
        .type("html")
        .send(
          page(
            "Install the VPS runner",
            `<h1>Your VPS, connected.</h1><p class="lead">The shared API needs no local installation. Deploying apps uses a runner you install and pair on your own VPS. SSH keys and environment files stay there.</p><section class="panel"><h2>Install ${e(m.version)}</h2><p>Requires Node.js 22.13 or later and Docker. The runner supports stateless HTTP apps with a Dockerfile.</p><code>npm install --global --ignore-scripts ${e(url)}</code><p><a href="${e(url)}">Download the package</a> · <a href="/releases/latest.json">Release manifest</a></p><small>SHA-256</small><code>${e(m.sha256)}</code></section><section class="section"><h2>Pair the runner</h2><p>On the VPS, use a new private directory outside your repository. Configure the repository and hostname you want it to manage. The Nginx adapter needs Nginx, certbot, an existing ACME account and permission to install its own route and reload Nginx.</p><code>infomaniak-ai runner init --directory /home/USER/.config/infomaniak-runner --name my-app --repository https://github.com/OWNER/REPO.git --hostname app.example.com --proxy nginx\ninfomaniak-ai runner pair --directory /home/USER/.config/infomaniak-runner\ninfomaniak-ai runner run --directory /home/USER/.config/infomaniak-runner</code><p>Open the pairing link in the browser where you connected your AI. Review the allowed app, repository and hostname. Each deployment still needs a separate plan approval.</p><p>For an existing external reverse proxy, use <code class="inline-code">--proxy external --port UNUSED_LOOPBACK_PORT</code>; that proxy remains responsible for public TLS.</p></section>`,
          ),
        );
    } catch {
      res
        .status(503)
        .type("html")
        .send(
          page(
            "Release unavailable",
            "<h1>The runner download is not ready.</h1><p>Try again after the operator finishes this release.</p>",
          ),
        );
    }
  });
  app.get("/downloads/:file", async (req, res) => {
    try {
      const m = await manifest();
      if (String(req.params.file) !== m.filename) {
        res.sendStatus(404);
        return;
      }
      res
        .set({
          "cache-control": "public, max-age=86400",
          "content-disposition": `attachment; filename="${m.filename}"`,
        })
        .type("application/gzip")
        .send(await readFile(new URL("../release-assets/" + m.filename, import.meta.url)));
    } catch {
      res.sendStatus(404);
    }
  });
}
