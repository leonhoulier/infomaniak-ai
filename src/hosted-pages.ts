import { HOSTED_STYLES } from "./hosted-style.js";

export const escapeHtml = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const e = escapeHtml;
export const SOURCE = "https://github.com/leonhoulier/infomaniak-ai";
const paths = {
  cloud:
    '<path d="M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19.8 10 4 4 0 0 1 19 18H7Z"/><path d="m9 13 3 3 3-3m-3-3v6"/>',
  link: '<path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16"/>',
  chat: '<path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 1 1 17-5Z"/><path d="M8 10h8m-8 4h5"/>',
  account: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  server:
    '<rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01m4-11h4m-4 11h4"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  moon: '<path d="M20.5 14.2A9 9 0 0 1 9.8 3.5a9 9 0 1 0 10.7 10.7Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>',
  github:
    '<path d="M9 19c-4 1-4-2-6-2m12 5v-3.9a3.4 3.4 0 0 0-.9-2.7c3-.3 6.2-1.5 6.2-6.8a5.3 5.3 0 0 0-1.5-3.7 4.9 4.9 0 0 0-.1-3.6s-1.2-.4-3.8 1.4a12.5 12.5 0 0 0-6.8 0C5.5.9 4.3 1.3 4.3 1.3a4.9 4.9 0 0 0-.1 3.6 5.3 5.3 0 0 0-1.5 3.7c0 5.3 3.2 6.5 6.2 6.8a3.4 3.4 0 0 0-.9 2.7V22"/>',
};
const icon = (name: keyof typeof paths, css = "") =>
  `<svg ${css ? `class="${css}"` : ""} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;

export const COPY_SCRIPT = `document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const target = document.getElementById(button.dataset.copy);
    if (!target) return;
    const text = target instanceof HTMLInputElement ? target.value : target.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, 2000);
    } catch {
      button.textContent = 'Select and copy';
      if (target instanceof HTMLInputElement) { target.focus(); target.select(); }
      else { const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(target); selection.removeAllRanges(); selection.addRange(range); }
    }
  });
});`;

interface PageMetadata {
  origin: string;
  path: string;
  description: string;
  copy?: boolean;
  application?: boolean;
}
export function page(
  title: string,
  body: string,
  previewNotice?: string,
  meta?: PageMetadata,
): string {
  const publicPage = meta && !previewNotice;
  const url = meta ? new URL(meta.path, meta.origin).href : undefined;
  const fullTitle = title === "Infomaniak MCP" ? title : title + " · Infomaniak MCP";
  const description =
    meta?.description ??
    "Connect your Infomaniak account privately. Independent MCP service for account and product discovery.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="description" content="${e(description)}"><meta name="robots" content="${publicPage ? "index,follow" : "noindex,nofollow"}"><meta name="author" content="Léon Houlier"><title>${e(fullTitle)}</title>${publicPage ? `<link rel="canonical" href="${e(url)}"><meta property="og:type" content="website"><meta property="og:site_name" content="Infomaniak MCP"><meta property="og:title" content="${e(fullTitle)}"><meta property="og:description" content="${e(description)}"><meta property="og:url" content="${e(url)}"><meta property="og:image" content="${e(new URL("/social.png", meta.origin).href)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="Connect Infomaniak to your AI tools. Independent service by Léon Houlier. Scoped resource access and reviewed changes."><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${e(new URL("/social.png", meta.origin).href)}"><meta name="twitter:title" content="${e(fullTitle)}"><meta name="twitter:description" content="${e(description)}">` : ""}<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="preload" href="/fonts/IBMPlexSans-Regular.woff2" as="font" type="font/woff2" crossorigin><style>${HOSTED_STYLES}</style></head><body><a class="skip" href="#main">Skip to content</a><header class="topbar"><nav class="navigation" aria-label="Main navigation"><a class="brand" href="/" aria-label="Infomaniak MCP home"><span>Infomaniak</span><span class="brand-suffix">MCP</span></a><div class="nav-actions"><a class="nav-link api-link" href="/api">API</a><a class="nav-link" href="${SOURCE}" target="_blank" rel="noopener noreferrer">GitHub</a><input class="sr-only" id="theme-switch" type="checkbox" aria-label="Dark appearance"><label class="theme-control" for="theme-switch" title="Change appearance">${icon("moon", "moon")}${icon("sun", "sun")}</label></div></nav></header><main id="main" ${meta?.application ? 'itemscope itemtype="https://schema.org/SoftwareApplication"' : ""}>${previewNotice ? `<p class="notice" role="note">${e(previewNotice)}</p>` : ""}${body}<footer><div class="footer-links"><a href="${SOURCE}" target="_blank" rel="noopener noreferrer">Source on GitHub</a><a href="${SOURCE}/blob/main/CONTRIBUTING.md">Contribute</a><a href="/plugins">Plugins</a><a href="/support">Support</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/cookies">Cookies</a><a href="/api">API docs</a><a href="/operations">Operations</a><a href="/connections">Manage connection</a><a href="/healthz">Health</a></div><p>Built by <a href="https://leonhoulier.com" rel="me">Léon Houlier</a>. Hosted on Infomaniak.</p><small>Independent and unofficial. Not affiliated with or endorsed by Infomaniak.</small></footer></main>${meta?.copy ? `<script>${COPY_SCRIPT}</script>` : ""}</body></html>`;
}

const clients = {
  claude: {
    name: "Claude",
    heading: "Connect from Claude",
    url: "https://claude.ai/",
    steps: [
      "Open Customize → Connectors and add a custom web connector. Team workspaces may need an owner to add it first.",
      "Paste the connection URL above. Choose sign-in authentication and ‘Register automatically’ for the OAuth client.",
      "Connect, enter your Infomaniak API token on this service’s private page, and choose the account to share.",
      "Return to your conversation, enable the connector and ask it to show your Infomaniak services.",
    ],
  },
  chatgpt: {
    name: "ChatGPT",
    heading: "Connect from ChatGPT",
    url: "https://chatgpt.com/",
    steps: [
      "Open Plugins in ChatGPT on the web. Select the plus button, then ‘Add custom MCP server’. Your workspace must allow custom MCP connections.",
      "Paste the connection URL above and choose OAuth authentication with dynamic client registration (DCR). No fixed client credentials are needed.",
      "Create and install the plugin. Complete the private connection page with your own Infomaniak API token, then choose an account.",
      "In a conversation, type @, select Infomaniak MCP and ask it to show your services.",
    ],
  },
  grok: {
    name: "Grok",
    heading: "Connect a Grok bot through the API",
    url: "https://docs.x.ai/developers/tools/remote-mcp",
    steps: [
      "Use a bot or API integration that supports remote MCP over Streamable HTTP and the OAuth authorization-code flow with S256 PKCE.",
      "Connect it to the server URL above. Complete this service’s private browser consent with your own Infomaniak token and chosen resources.",
      "Pass the separate MCP OAuth access credential to xAI’s remote MCP authorization field. Store and refresh it in your bot’s secret store; never use the Infomaniak provider token there.",
      "Grok.com and Grok Bot installation have not been qualified. API support does not prove a one-click connector exists in your app.",
    ],
  },
  other: {
    name: "Other clients",
    heading: "Use another MCP client",
    url: undefined,
    steps: [
      "Add a remote Streamable HTTP MCP server using the connection URL above.",
      "Use an MCP client with OAuth authorization-code support, S256 PKCE and dynamic client registration.",
      "Complete browser consent with your Infomaniak API token and explicitly choose one account.",
      "Enable the connection and ask for your services. Exact configuration options vary between clients.",
    ],
  },
  codex: {
    name: "Codex",
    heading: "Connect from Codex",
    url: "https://chatgpt.com/codex",
    steps: [
      "Add the remote server using the command below. Codex may open an initial sign-in; the login command explicitly requests resource access. Choose read-only in browser consent if you prefer.",
      "Complete the private browser consent page with your own Infomaniak token and chosen resources.",
      "Start Codex and ask it to inspect your Infomaniak services. Your token never belongs in the conversation.",
    ],
  },
  cursor: {
    name: "Cursor",
    heading: "Connect from Cursor",
    url: "https://cursor.com",
    steps: [
      "Use the native install link below and confirm the server in Cursor.",
      "When Cursor asks you to sign in, complete this service’s private browser consent page.",
      "Enable the server and ask for your services. Use the selected resource names; the connector can resolve IDs.",
    ],
  },
  vscode: {
    name: "VS Code",
    heading: "Connect from VS Code",
    url: "https://code.visualstudio.com",
    steps: [
      "Use the native install link below, or run MCP: Add Server and choose HTTP in VS Code.",
      "Enter the MCP URL and select the configuration scope you want. Use OAuth discovery rather than pasting a provider token into JSON.",
      "Start the server, complete browser consent, then enable its tools in your agent conversation.",
    ],
  },
};
type ClientKey = keyof typeof clients;

function instructions(client: ClientKey, endpoint: string, resourceWrites = false): string {
  const info = clients[client];
  if (["codex", "cursor", "vscode"].includes(client)) {
    const install =
      client === "codex"
        ? `<code>codex mcp add infomaniak --url ${e(endpoint)}\ncodex mcp login infomaniak${resourceWrites ? " --scopes infomaniak:read,infomaniak:write:dns,infomaniak:write:mail,infomaniak:deploy" : ""}</code>`
        : client === "cursor"
          ? `<a class="button" href="${e("cursor://anysphere.cursor-deeplink/mcp/install?name=infomaniak&config=" + encodeURIComponent(Buffer.from(JSON.stringify({ url: endpoint })).toString("base64")))}">Install in Cursor</a>`
          : `<a class="button" href="${e("vscode:mcp/install?" + encodeURIComponent(JSON.stringify({ name: "infomaniak", type: "http", url: endpoint })))}">Install in VS Code</a>`;
    return `<h3 id="title-${client}">${info.heading}</h3>${install}<ol class="instructions">${info.steps.map((step) => `<li>${e(step)}</li>`).join("")}</ol>`;
  }
  return `<h3 id="title-${client}">${info.heading}</h3><ol class="instructions">${info.steps.map((step) => `<li>${e(step)}</li>`).join("")}</ol>${client === "other" ? `<code>${e(JSON.stringify({ mcpServers: { infomaniak: { url: endpoint } } }, null, 2))}</code><small>Use this URL-based configuration only if your client supports it.</small>` : `<a class="button secondary" href="${info.url}" target="_blank" rel="noopener noreferrer">Open ${info.name}${icon("arrow")}</a>`}`;
}
function setup(endpoint: string, writesEnabled = false, resourceWrites = false): string {
  return `<div class="panel setup-panel" id="setup"><fieldset><legend class="sr-only">Choose your AI app</legend><div class="setup-tabs">${(Object.keys(clients) as ClientKey[]).map((client, index) => `<input class="sr-only" type="radio" name="setup-client" id="client-${client}" aria-controls="panel-${client}" ${index === 0 ? "checked" : ""}><label for="client-${client}">${clients[client].name}</label>`).join("")}</div><label class="endpoint-label" for="mcp-endpoint">MCP server URL</label><input class="endpoint-field" id="mcp-endpoint" type="text" readonly spellcheck="false" value="${e(endpoint)}"><p class="endpoint-hint">Select and copy this URL into your AI app’s connection settings.</p>${(Object.keys(clients) as ClientKey[]).map((client) => `<section class="client-panel" id="panel-${client}" aria-labelledby="title-${client}">${instructions(client, endpoint, resourceWrites)}</section>`).join("")}<p class="setup-footnote">Public pilot · account and product discovery${writesEnabled ? (resourceWrites ? "; DNS, mail and paired deployment changes need resource consent and approval" : "; optional disposable TXT writes need separate consent and confirmation") : " only"}. Native app compatibility is still being qualified; settings and availability depend on your app and workspace. Enter your token only on this service’s private connection page.</p></fieldset></div>`;
}

export function home(
  endpoint: string,
  previewNotice?: string,
  writesEnabled = false,
  resourceWrites = false,
): string {
  const capabilities = [
    {
      title: "Your account",
      symbol: "account",
      body: "Only the account you choose. Other accounts remain outside the connection.",
    },
    {
      title: "Your services",
      symbol: "server",
      body: "Domains, Mail Service, VPS and other products, with their names and IDs.",
    },
    {
      title: "API catalogue",
      symbol: "search",
      body: "Documented operations and product routes. Discovery does not grant permission to run them.",
    },
    {
      title: "Your connection",
      symbol: "shield",
      body: "A separate OAuth credential for your AI. Disconnect whenever you need to.",
    },
  ] as const;
  const faqs = [
    [
      "What can I do with it today?",
      resourceWrites
        ? "Inspect DNS, manage records, aliases and forwarding for the resources you approve. A paired customer-owned runner can deploy a pinned repository commit and recover the previous release. The API catalogue also shows operations that are not implemented."
        : "The hosted pilot lists your approved account and its products and searches the API catalogue. The optional write scope manages the disposable TXT name only.",
    ],
    [
      "Do I need to host or install anything?",
      "No. Everyone connects to the same hosted MCP endpoint using their own Infomaniak credentials. You need a compatible AI app and an API token with the accounts and product read permissions required for inventory.",
    ],
    [
      "Does it use Infomaniak sign-in?",
      "The current connection uses your Infomaniak API token, entered in this site’s private password field. It is not Infomaniak Manager login or delegated Infomaniak OAuth. Never enter your Manager password or paste a token into chat.",
    ],
    [
      "How is my token protected?",
      "Your token is sent over HTTPS and encrypted on the service. The operator can decrypt it to make API requests. Your AI gets a separate credential for the account you approved, and receives the account and product information you request under its own terms.",
    ],
    [
      "Can it change my DNS, mail or VPS?",
      resourceWrites && writesEnabled
        ? "Yes. New connections offer reviewed writes for domains and mailboxes you choose. DNS changes, aliases, forwarding and runner deployments each require a separate plan approval. Mailbox content, billing and arbitrary shell execution are unavailable."
        : writesEnabled
          ? "New connections offer DNS writes by default. Choose one verified domain and allow access, or uncheck DNS writes for a read-only connection. The current beta can create, update and delete TXT records only at _infomaniak-ai-test. Every plan requires client confirmation when supported, with a browser fallback. Mail, VPS, other DNS names and non-TXT records remain unavailable."
          : "No. Hosted provider requests are GET-only and no write tool is exposed. Broader resource reads and independently approved writes belong to a separate policy edition.",
    ],
    [
      "Which AI apps can connect?",
      "The service is designed for remote MCP clients supporting OAuth, S256 PKCE and dynamic client registration. Setup guides cover Claude, ChatGPT and Grok.com. Their native connection flows are still being qualified. Grok Bot has a separate plugin interface and is not qualified yet.",
    ],
    [
      "How do I disconnect?",
      "Open Manage connection in the same browser you used to authorise access. Disconnecting stops new requests and deletes the live stored provider token. If you lose that browser, revoke the API token in Infomaniak. See Connection privacy for expiry and backup details.",
    ],
  ];
  const origin = new URL(endpoint).origin;
  return page(
    "Infomaniak MCP for AI coding tools",
    `<section class="hero hero-grid" aria-labelledby="hero-heading"><div class="hero-copy"><meta itemprop="name" content="Infomaniak MCP"><h1 id="hero-heading">Connect Infomaniak<br>to your AI tools.</h1><p class="lead" itemprop="description">${resourceWrites && writesEnabled ? "Manage your domains, mail and app deployments from your AI." : "Account inventory and API discovery, using your own Infomaniak token."}</p><div class="hero-actions"><a class="button" href="#setup">Set up your AI${icon("arrow")}</a><a class="button secondary" href="/api">Use the API</a><a class="button secondary" href="/plugins">Get the plugin</a></div><p class="hero-limit">${resourceWrites && writesEnabled ? 'DNS, mail and VPS deployment. <a href="/api">Scoped access, with your approval.</a>' : writesEnabled ? 'DNS writes with your approval. <a href="/api">Current beta: test TXT records only.</a> Read-only access available.' : "Read-only discovery."}</p><p class="hero-limit">Open source, MIT licensed. <a href="${SOURCE}/blob/main/CONTRIBUTING.md">Contributions welcome.</a></p><meta itemprop="applicationCategory" content="DeveloperApplication"><meta itemprop="operatingSystem" content="Any MCP-compatible client"><a itemprop="url" class="sr-only" href="${e(origin)}">Infomaniak MCP website</a><a itemprop="author" itemscope itemtype="https://schema.org/Person" class="sr-only" href="https://leonhoulier.com"><span itemprop="name">Léon Houlier</span></a></div><aside class="quickstart panel" aria-label="Quick connection"><h2>Add the server</h2><label class="endpoint-label" for="quick-endpoint">MCP server URL</label><div class="copy-row"><input class="endpoint-field" id="quick-endpoint" type="text" readonly spellcheck="false" value="${e(endpoint)}"><button type="button" class="copy-button" data-copy="quick-endpoint" aria-label="Copy MCP server URL">Copy</button></div><div class="client-pills"><a href="/clients/claude">Claude</a><a href="/clients/chatgpt">ChatGPT</a><a href="/clients/grok">Grok</a><a href="/clients/codex">Codex</a><a href="/clients/cursor">Cursor</a><a href="/clients/vscode">VS Code</a><a href="/clients/other">Other clients</a></div><details class="quick-command" open><summary>Claude Code command</summary><div class="copy-row"><code id="claude-command">claude mcp add --transport http infomaniak ${e(endpoint)}</code><button type="button" class="copy-button" data-copy="claude-command" aria-label="Copy Claude Code command">Copy</button></div><small>Then run /mcp in Claude Code and complete browser sign-in.</small></details><p class="quick-privacy">Enter your token on the private connection page. <a href="/privacy">How it is stored</a>.</p><small>OAuth + PKCE. <a href="/clients/status.json">Client qualification status</a>.</small></aside></section><section class="section" id="discovery" aria-labelledby="discovery-heading"><div class="section-heading"><h2 id="discovery-heading">What it can access</h2><a href="/api">API reference ${icon("arrow")}</a></div><dl class="capability-list">${capabilities.map((item) => `<div><dt>${item.title}</dt><dd>${item.body}</dd></div>`).join("")}</dl><details class="tool-reference"><summary>The four discovery tools</summary><dl class="tool-list"><dt><code class="inline-code">infomaniak_status</code></dt><dd>Connection capabilities and limits.</dd><dt><code class="inline-code">infomaniak_read</code></dt><dd>Your approved account and its products.</dd><dt><code class="inline-code">infomaniak_search</code></dt><dd>Relevant public API operations.</dd><dt><code class="inline-code">infomaniak_catalogue</code></dt><dd>Public metadata by product and method.</dd></dl><p><a href="/llms.txt">Plain-text reference for AI tools</a></p></details></section><details class="setup-details"><summary>Setup instructions</summary><p class="section-intro">Connect your account first. Pair your own runner when you want to deploy to a VPS.</p>${setup(endpoint, writesEnabled, resourceWrites)}</details><section class="section faq" aria-labelledby="faq-heading"><h2 id="faq-heading">Connection details</h2>${faqs.map(([question, answer]) => `<details><summary>${e(question)}</summary><p>${e(answer)}</p></details>`).join("")}</section>`,
    previewNotice,
    {
      origin,
      path: "/",
      description:
        "Connect Infomaniak to your AI coding tools through MCP. Private token entry, scoped resource access and reviewed changes.",
      copy: true,
      application: true,
    },
  );
}

export function clientGuide(
  client: string,
  endpoint: string,
  previewNotice?: string,
  resourceWrites = false,
): string | undefined {
  if (!Object.hasOwn(clients, client)) return undefined;
  const key = client as ClientKey,
    info = clients[key];
  return page(
    "Connect with " + info.name,
    `<h1>Infomaniak, in ${key === "other" ? "your AI workspace" : info.name}.</h1><p class="lead">Use the shared service with your own Infomaniak account. There is no local server to install.</p><section class="panel"><label class="endpoint-label" for="client-endpoint">MCP server URL</label><input class="endpoint-field" id="client-endpoint" type="text" readonly spellcheck="false" value="${e(endpoint)}"><p class="endpoint-hint">Select and copy this URL into your AI app’s connection settings.</p>${instructions(key, endpoint, resourceWrites)}<p class="notice" style="margin-top:24px">Enter your Infomaniak token only on this service’s private connection page. It is encrypted on the service; your AI receives a separate OAuth credential.</p><small>${resourceWrites ? "Resource operations use the access you approve; deployment needs a paired runner." : "Public pilot: account and product discovery."} Check the client qualification status; app settings and availability vary by plan.</small></section><p style="margin-top:24px"><a href="/#setup">Choose another AI app</a></p>${key === "codex" ? '<p><a href="https://learn.chatgpt.com/docs/config-file/config-reference">Official Codex configuration reference</a></p>' : key === "chatgpt" ? '<p><a href="https://developers.openai.com/plugins/quickstart">Official ChatGPT plugin setup</a></p>' : key === "grok" ? '<p><a href="https://docs.x.ai/developers/tools/remote-mcp">Official xAI remote MCP documentation</a></p>' : ""}`,
    previewNotice,
    {
      origin: new URL(endpoint).origin,
      path: "/clients/" + client,
      description:
        "Connect Infomaniak MCP to " +
        info.name +
        ". Private token entry and OAuth resource consent. See the client qualification page for verified compatibility.",
    },
  );
}
