import { page, escapeHtml as e, SOURCE } from "./hosted-pages.js";
import { DNS_SCOPE, MAIL_SCOPE, DEPLOY_SCOPE } from "./hosted-resources.js";
import { DOCUMENTATION_STATUS } from "./documentation.js";

export const PUBLIC_PATHS = [
  "/",
  "/api",
  "/privacy",
  "/cookies",
  "/clients/claude",
  "/clients/chatgpt",
  "/clients/grok",
  "/clients/other",
  "/clients/codex",
  "/clients/cursor",
  "/clients/vscode",
  "/downloads",
  "/plugins",
  "/clients",
] as const;
export const HOSTED_TOOLS = [
  "infomaniak_status",
  "infomaniak_read",
  "infomaniak_search",
  "infomaniak_catalogue",
  "infomaniak_docs_search",
  "infomaniak_docs_read",
] as const;
export function capabilities(origin: URL, writesEnabled = false, resourceWrites = false) {
  if (writesEnabled && resourceWrites)
    return {
      name: "Infomaniak MCP",
      version: "0.3.4",
      documentation_access: DOCUMENTATION_STATUS,
      unofficial: true,
      mode: "hosted-resources",
      writes_enabled: true,
      default_connection: "read-write-with-consent",
      default_scopes: ["infomaniak:read", DNS_SCOPE, MAIL_SCOPE, DEPLOY_SCOPE],
      read_only_available: true,
      tools: [
        ...HOSTED_TOOLS,
        "infomaniak_plan",
        "infomaniak_execute",
        "infomaniak_operation",
        "infomaniak_cancel",
      ],
      available_reads: [
        "accounts.list",
        "products.list",
        "resources.resolve",
        "dns.records.list",
        "dns.audit",
        "dns.propagation",
        "domains.expiry",
        "mail.mailbox.get",
        "mail.aliases.list",
        "mail.forwarding.get",
        "deployment.app.get",
        "deployment.runner.health",
        "deployment.logs",
        "deployment.job.get",
      ],
      available_writes: [
        "dns.record.create",
        "dns.record.update",
        "dns.record.delete",
        "mail.alias.add",
        "mail.alias.delete",
        "mail.forwarding.add",
        "mail.forwarding.delete",
        "mail.forwarding.update",
        "deployment.release",
        "deployment.rollback",
      ],
      resource_consent_required: true,
      approval:
        "Client-native confirmation when form elicitation is negotiated; browser fallback otherwise",
      native_confirmation: "MCP form elicitation, bound to the exact plan and connection",
      json_api_confirmation: "Independent browser review",
      mcp_url: new URL("/mcp", origin).href,
      documentation: new URL("/api", origin).href,
      client_status: new URL("/clients/status.json", origin).href,
      runner_installation: new URL("/downloads", origin).href,
      limitations: [
        "One approved account per connection; only named, verified domains and mailboxes",
        "Deployment needs a paired customer-owned runner and a pinned repository commit",
        "Stateless HTTP Dockerfile apps; data and database migrations are not rolled back",
        "No arbitrary HTTP executor, shell command, billing actions or mailbox content",
        "Catalogue coverage is not executable coverage; client qualification is listed separately",
      ],
    };
  return {
    name: "Infomaniak MCP",
    documentation_access: DOCUMENTATION_STATUS,
    unofficial: true,
    mode: writesEnabled ? "hosted-scoped-dns-beta" : "hosted-discovery",
    writes_enabled: writesEnabled,
    default_connection: writesEnabled ? "read-write-with-consent" : "read-only",
    default_scopes: writesEnabled
      ? ["infomaniak:read", "infomaniak:write:disposable-dns"]
      : ["infomaniak:read"],
    read_only_available: true,
    optional_writes: writesEnabled
      ? {
          scope: "infomaniak:write:disposable-dns",
          operations: ["dns.record.create", "dns.record.update", "dns.record.delete"],
          source: "_infomaniak-ai-test",
          type: "TXT",
          approval:
            "Client confirmation when supported; browser review for other clients and the JSON API",
        }
      : null,
    mcp_url: new URL("/mcp", origin).href,
    documentation: new URL("/api", origin).href,
    authentication: "OAuth authorization code, S256 PKCE and dynamic client registration",
    tools: HOSTED_TOOLS,
    optional_tools: writesEnabled
      ? ["infomaniak_plan", "infomaniak_execute", "infomaniak_operation", "infomaniak_cancel"]
      : [],
    available_reads: ["accounts.list", "products.list"],
    limitations: [
      "One explicitly approved account per connection",
      "Public catalogue entries are not executable coverage",
      writesEnabled
        ? "Only explicitly consented disposable TXT writes; no SSH, deployment, mail or VPS mutations"
        : "No hosted writes, SSH, deployment or mailbox content",
      "Native client compatibility is still being qualified",
    ],
  };
}
export function publicPage(
  path: string,
  origin: URL,
  analytics: boolean,
  previewNotice?: string,
  writesEnabled = false,
  resourceWrites = false,
): string | undefined {
  const render = (title: string, description: string, body: string, copy = false) =>
    page(
      title,
      body +
        (path === "/api"
          ? `<section class="section"><h2>Current official documentation</h2><p>Use <code class="inline-code">infomaniak_docs_search</code> for current help guides or the developer API index, then <code class="inline-code">infomaniak_docs_read</code> for the full reference. Help search supports English, French, German, Italian, Spanish, Dutch and Portuguese. Each call fetches from Infomaniak; results include source links, retrieval time and explicit pagination. No bundled article cache is substituted if a fetch fails.</p><code>{"query":"create email address","source":"help","language":"en"}</code><p>For Manager tasks without a supported API operation, an agent can follow the guide using its own authorized browser or computer tools. It should check the actual UI, account and product. These tools do not control a browser or expand permissions.</p><p>The OAuth-protected JSON equivalents are <code class="inline-code">POST /api/v1/docs/search</code> and <code class="inline-code">POST /api/v1/docs/read</code>. Supply the same arguments as the MCP tools. Use public topic terms only in searches. Documentation requests never include your Infomaniak token or browser cookies.</p></section>`
          : path === "/privacy"
            ? `<section class="section"><h2>Documentation requests</h2><p>Official help search sends the public topic terms you supply to Infomaniak. API documentation search fetches the public index and matches terms here. Page reading requests the chosen official URL. We do not attach provider credentials, account details or browser cookies to these requests. Do not put private customer information in a documentation search. Infomaniak may log these requests under its own privacy policy.</p></section>`
            : ""),
      previewNotice,
      { origin: origin.origin, path, description, copy },
    );
  if (path === "/api" && resourceWrites && writesEnabled)
    return render(
      "API documentation",
      "Manage consented Infomaniak DNS and mail resources, and deploy apps through your own VPS runner. MCP and OAuth-protected JSON API.",
      `<h1>From a request to a verified change.</h1><p class="lead">Use the same account and resource consent through MCP or the OAuth-protected JSON API. New clients offer read and write access; you can choose read-only.</p><section class="panel"><h2>Try the public endpoint</h2><code>curl ${e(origin.origin)}/api/capabilities</code><p><a href="/api/capabilities">View capabilities</a>. No token or customer data is involved.</p></section><section class="section"><h2>What works</h2><dl class="tool-list"><dt>DNS</dt><dd>Inspect records and mail-authentication configuration. Create, edit and delete records in consented domains. Check propagation separately from provider readback.</dd><dt>Mail</dt><dd>Inspect consented mailbox metadata, aliases and forwarding. Add/remove aliases and recipients, and review forwarding-setting changes. Message content is not exposed.</dd><dt>VPS apps</dt><dd>Pair your customer-owned runner, inspect health, request logs, deploy a pinned repository commit and recover the retained previous release. Stateless HTTP Dockerfile apps only.</dd></dl><p>Use <code class="inline-code">resources.resolve</code> to find product names and IDs, then <code class="inline-code">infomaniak_search</code> to load a relevant operation schema. Only resources granted to this connection can be changed.</p></section><section class="section"><h2>One write lifecycle</h2><ol><li>Create a plan. It captures current state, exact arguments, impact and recovery.</li><li>For MCP, follow approval_method: client opens a native confirmation when infomaniak_execute is called; browser opens approval_url. JSON API users review approval_url in the consenting browser.</li><li>Execute using the matching plan_hash. Each plan can send its mutation once.</li><li>Inspect plan.state. Reconcile pending/unknown outcomes through reads; do not resend.</li></ol><p>Verified DNS state means provider readback, not global propagation. A runner reports whether app health was checked on loopback or through public TLS.</p><code>{"operation":"dns.record.create","arguments":{"account_id":123,"zone":"example.com","source":"staging","type":"A","target":"192.0.2.10","ttl":300}}</code></section><section class="section"><h2>JSON routes</h2><dl class="tool-list"><dt>GET /api/v1/capabilities</dt><dd>Effective account, resources and operations.</dd><dt>POST /api/v1/reads</dt><dd>Reviewed reads using operation and arguments.</dd><dt>POST /api/v1/plans</dt><dd>Prepare an exact write plan.</dd><dt>GET /api/v1/plans/{id}</dt><dd>Inspect a connection-owned plan.</dd><dt>POST /api/v1/plans/{id}/execute</dt><dd>Execute after independent approval; body contains plan_hash.</dd><dt>POST /api/v1/plans/{id}/reconcile</dt><dd>Read back an uncertain result.</dd><dt>POST /api/v1/plans/{id}/cancel</dt><dd>Cancel before execution.</dd></dl><p>Use the OAuth credential issued to your AI client, bound to this service's /mcp resource. The Infomaniak provider token belongs only on the private browser form. JSON bodies are uncompressed and limited to 16 KiB.</p><p><a href="/operations">Private operations</a> · <a href="/downloads">Install a runner</a> · <a href="/clients">Tested clients</a> · <a href="/llms.txt">AI reference</a></p></section>`,
    );
  if (path === "/privacy")
    return render(
      "Privacy policy",
      "How Infomaniak MCP handles tokens, account data, analytics and deletion. Operated by Léon Houlier on Infomaniak.",
      `
    <h1>Privacy, in plain terms.</h1><p class="muted">Updated 29 October 2026</p><div class="policy">
    <p class="lead">Infomaniak MCP is an independent service operated by <a href="https://leonhoulier.com">Léon Houlier</a>. Contact <a href="mailto:leon@houlier.com">leon@houlier.com</a> about your data.</p>
    <h2>Your token and account</h2><p>You enter your own Infomaniak API token over HTTPS. We use it for account and product reads${writesEnabled ? (resourceWrites ? ", and for the DNS and mailbox administration changes you consent to and approve" : ", and for the limited DNS tests you separately consent to and approve") : ""}, and store it encrypted on an Infomaniak server in Switzerland. The operator holds the encryption key and can decrypt the token to make those calls. This is not end-to-end encryption.</p>
    <p>Your AI receives a separate OAuth credential for the account you approve. Account and product information${writesEnabled ? ", including DNS plan values returned by write tools," : ""} goes to your AI provider when you request it, under its terms. We do not receive your AI conversation, read mailbox contents or sell your data.</p>
    ${resourceWrites && writesEnabled ? `<h2>Resource plans and runner reports</h2><p>You choose domains and mailbox addresses and can enroll a customer-owned runner through a separate pairing review. DNS, aliases, forwarding and deployments require per-plan approval. Resource names, changes, runner app definitions, signed health reports and explicitly requested logs are encrypted in the same vault. App environment files and SSH keys stay on the VPS. Finished plans are kept for up to seven days with bounded history; requested logs and disconnected-connection history expire after seven days; uncertain plans retain their locks and deployment-job evidence until investigated. Runner revocation stops new jobs. Signed completion for an already-issued deployment remains accepted; its verification identity remains until that work finishes, then expires after seven days. A request already in progress may finish after revocation.</p>` : writesEnabled ? `<h2>DNS write plans</h2><p>New connections offer DNS write access by default. You can uncheck it for read-only access. After you choose an account, enter a verified domain and allow the selected access, the service can create, update or delete TXT records only at _infomaniak-ai-test. Each exact plan needs client confirmation when supported, or approval in the browser that gave consent. Plan values are encrypted in the same vault. Finished plans are kept for up to seven days with bounded history; uncertain outcomes and their resource locks remain until reconciled or investigated. Disconnecting stops new operations; a provider request already in progress may finish.</p>` : ""}<h2>Expiry and deletion</h2><p>Unfinished sign-in expires after 10 minutes. Connections expire after 30 days; access credentials last 15 minutes and refresh credentials rotate. Expired records are removed during store housekeeping. Disconnecting immediately deletes the live stored provider credential and invalidates that connection.</p>
    <p>Encrypted daily backups are kept for seven days. A deleted credential may remain in those backups until they expire. Revoke the API token in Infomaniak to disable any retained copy. To request access, correction or deletion, email the address above. Never send a token by email.</p>
    <h2>Cookies and request data</h2><p>The public website sets no cookies. Sign-in uses only the essential cookies described in our <a href="/cookies">cookie policy</a>. Pages load no external fonts, tracking pixels or session recording scripts. Our small copy-button script runs in your browser and sends nothing.</p>
    <p>The server receives your IP address to handle requests. Application access logs omit IP addresses, query strings, tokens and request bodies. Access logs rotate daily, with up to 14 archives. Container diagnostic logs are limited to three 10 MiB files and expire by rotation rather than a fixed date. Infrastructure providers may process connection metadata to operate the service.</p>
    <h2>Usage counts</h2><p>${analytics ? "We send limited event counts to PostHog in the EU: homepage views, connection approvals, disconnections and discovery-tool outcomes. They contain no stable visitor identifier, account ID, domain, email, IP address, token, request payload or error text. Each event uses a fresh random ID; no person profile is created. Counts are capped at 1,000 events per UTC day for this installation. We skip these events when a request sends Global Privacy Control or Do Not Track. Counts remain in the analytics project until deleted; they do not form a customer history." : "Usage analytics is disabled on this instance."}</p>
    <h2>Providers and purposes</h2><p>Infomaniak hosts the service and fulfils your API requests. ${analytics ? "PostHog processes the limited usage counts above. " : ""}Your chosen AI provider receives the tool results you request. We process connection data to provide the service, protect access and diagnose failures. Cloudflare supplies this domain’s registration and DNS; application requests go directly to Infomaniak.</p>
    <p><a class="button" href="/connections">Manage your connection</a></p></div>`,
    );
  if (path === "/cookies")
    return render(
      "Cookie policy",
      "Infomaniak MCP uses only essential sign-in and connection-management cookies. No advertising cookies or browser analytics.",
      `
    <h1>Only the cookies sign-in needs.</h1><p class="muted">Updated 29 October 2026</p><div class="policy"><p class="lead">Browsing this website sets no cookies. We do not use advertising cookies or store an analytics identifier in your browser.</p>
    <h2>When you connect</h2><dl class="tool-list"><dt><code class="inline-code">__Host-ik_connect</code></dt><dd>Protects the browser sign-in transaction. Expires after 10 minutes and is cleared when consent completes.</dd><dt><code class="inline-code">__Host-ik_manage</code></dt><dd>Lets this browser find and disconnect the connections you authorised and review their proposed write plans. Expires after 30 days.</dd></dl>
    <p>Both cookies are first-party, Secure, HttpOnly and SameSite=Lax. They hold random values, not your Infomaniak token. In an explicit local HTTP preview, their names omit the <code class="inline-code">__Host-</code> prefix and Secure is unavailable.</p>
    <h2>Your choice</h2><p>There is no “accept all” banner because we offer no optional browser cookies. Blocking the essential cookies prevents sign-in or browser connection management. You can delete them in your browser; deleting a cookie does not revoke the API token or the AI connection. Disconnect first, or revoke the token in Infomaniak.</p><p>The appearance switch lasts only for the open page. It does not save a cookie or local storage value. Server-side usage counts are described in the <a href="/privacy">privacy policy</a>.</p></div>`,
    );
  if (path === "/api")
    return render(
      "API documentation",
      "Use the Infomaniak MCP API with OAuth and four read-only tools. Public capabilities endpoint and authenticated JSON-RPC examples.",
      `
    <h1>An API your AI tools can use.</h1><p class="lead">Use MCP over Streamable HTTP for AI clients, or the OAuth-protected JSON API for your own integrations. It exposes account and product discovery for one approved Infomaniak account. It does not proxy arbitrary provider requests.</p>
    <div class="panel"><h2>Try the public endpoint</h2><div class="copy-row"><code id="api-command">curl ${e(new URL("/api/capabilities", origin).href)}</code><button type="button" class="copy-button" data-copy="api-command" aria-label="Copy API capabilities command">Copy</button></div><p>No token is needed. This returns service capabilities and limits, never customer data.</p><a href="/api/capabilities">View the JSON response</a></div>
    <section class="section"><h2>Read customer resources</h2><p>With your client’s OAuth credential, GET /api/v1/capabilities shows its effective scope. POST /api/v1/reads accepts the operation and arguments fields used by infomaniak_read below. These routes accept a read-only connection and never accept your provider token as a bearer credential.</p><p>Add <code class="inline-code">${e(new URL("/mcp", origin).href)}</code> to an MCP client supporting OAuth, S256 PKCE and dynamic client registration. Complete browser consent with your own Infomaniak API token. Your client receives a separate OAuth credential; never send the provider token as an MCP bearer token.</p><p>Send authenticated JSON-RPC requests by POST, with Content-Type application/json and Accept application/json, text/event-stream. Use an MCP SDK to handle initialization and OAuth. This is a tools/call payload after initialization:</p><code>${e(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "infomaniak_read", arguments: { operation: "accounts.list", arguments: {} } } }, null, 2))}</code><p>Next, call <code class="inline-code">products.list</code> with <code class="inline-code">account_id</code> from the authorised account. A tool error is reported inside the MCP response and is not necessarily an HTTP error.</p></section>
    ${writesEnabled ? `<section class="section"><h2>Hosted write API</h2><p>New connections request read and write access by default when no scope is specified. A client can explicitly request only read access. For write access, use both <code class="inline-code">infomaniak:read</code> and <code class="inline-code">infomaniak:write:disposable-dns</code> during OAuth. In the private consent page, choose one account, keep DNS writes enabled and enter a domain verified in that account before allowing access. Existing read-only connections stay read-only.</p><p>Only TXT records at <code class="inline-code">_infomaniak-ai-test</code> can change. Non-TXT records, other names, mail and VPS are protected. Use the same OAuth credential for the API below; it remains bound to this service’s /mcp resource.</p><dl class="tool-list"><dt>GET /api/v1/capabilities</dt><dd>Inspect the consented scope.</dd><dt>POST /api/v1/plans</dt><dd>Preview dns.record.create, update or delete with exact account and zone arguments.</dd><dt>GET /api/v1/plans/{id}</dt><dd>Inspect your own plan.</dd><dt>POST /api/v1/plans/{id}/execute</dt><dd>After independent browser approval, submit the matching plan_hash.</dd><dt>POST /api/v1/plans/{id}/reconcile</dt><dd>Read back an uncertain outcome, without repeating the mutation.</dd><dt>POST /api/v1/plans/{id}/cancel</dt><dd>Cancel before execution.</dd></dl><p>The plan response gives a /write-reviews/{id} URL. Open it in the consenting browser, review the complete change and type APPROVE. The API cannot approve its own plan. HTTP 200 is a returned outcome; inspect plan.state. Verified means provider readback, not DNS propagation. Do not repeat an uncertain write.</p><p>Search for DNS operations in your MCP client to load the reviewed schemas. A write-consented connection also exposes plan, execute, operation-status and cancel tools. Use account_id, zone and the exact source above; update/delete require expected_source and the record ID. Other API operations remain unavailable.</p></section>` : `<section class="section"><h2>Write API: separate policy edition</h2><p>The JSON write API is implemented and fixture-tested in the separately provisioned policy edition. This hosted installation has not enabled disposable DNS writes.</p></section>`}
    <section class="section"><h2>Tools and limits</h2><dl class="tool-list">${HOSTED_TOOLS.map((tool) => `<dt><code class="inline-code">${tool}</code></dt><dd>${{ infomaniak_status: "Connection capabilities and limits.", infomaniak_read: "accounts.list or products.list within the approved account.", infomaniak_search: "Search public API operation metadata.", infomaniak_catalogue: "Browse the public operation catalogue.", infomaniak_docs_search: "Search current official Manager guides or the developer API index.", infomaniak_docs_read: "Fetch current official reference text, steps and links." }[tool]}</dd>`).join("")}</dl><p>${writesEnabled ? "The hosted write API is limited to the consented disposable TXT name. No guest SSH, deployment or mailbox-content access." : "No hosted write endpoint, guest SSH, deployment or mailbox-content access."} A catalogue entry is documentation, not permission. Bodies are limited to 16 KiB; requests may return 400, 401, 403, 413 or 429. Refresh and revocation use the OAuth metadata endpoints.</p><p><a href="/.well-known/oauth-authorization-server">OAuth metadata</a> · <a href="/llms.txt">AI reference</a> · <a href="${SOURCE}">Source and separate policy edition</a></p></section>`,
      true,
    );
}
export function agentReference(origin: URL, writesEnabled = false, resourceWrites = false): string {
  if (writesEnabled && resourceWrites)
    return `# Infomaniak MCP\n\nIndependent service by Léon Houlier. ${origin.origin}/mcp is a shared Streamable HTTP MCP endpoint with OAuth/S256 PKCE.\n\nNew registrations offer read, DNS, mail and deployment access. Consent fixes one account and named resources. Existing grants do not expand. Resolve product names with infomaniak_read operation resources.resolve. Search loads reviewed schemas on demand.\n\nDNS: records, audit, propagation, create/update/delete in consented domains. Mail: metadata, aliases and forwarding for consented mailboxes; no messages. Deployment: pair a customer-owned runner at /runners; deploy pinned Git commits, request logs and prepare rollback for stateless Dockerfile HTTP apps. SSH keys and app environment files stay on the VPS.\n\nUse infomaniak_plan and inspect approval_method. For client, call infomaniak_execute with the exact id/hash to request native user confirmation. For browser, open approval_url for independent review before execution. Credentials always stay in the private browser consent page. Poll infomaniak_operation; reconcile unknown outcomes without repeating mutations. The JSON facade is /api/v1. Provider verification, public propagation and app health are separate evidence.\n\nTokens never belong in chat, tool arguments or client JSON. Enter them only at this service's private consent page. Store and journal values are encrypted; the operator holds the encryption key.\n\nCurrent official documentation: use infomaniak_docs_search with public topic terms, then infomaniak_docs_read. source help searches official guides in seven languages; source api searches the live developer index. Each read fetches current content and returns source, retrieved_at and explicit pagination. For a task missing a supported API capability, follow the guide using your own authorized browser/computer tools and verify the visible account, product and result. Documentation does not grant permission or bypass denied scopes, pending approvals or resource locks. Never send private customer details in documentation searches.\n\nReferences: ${origin.origin}/api ; ${origin.origin}/api/capabilities ; ${origin.origin}/clients ; ${origin.origin}/downloads ; ${origin.origin}/privacy ; ${origin.origin}/operations\n\nCatalogue entries are documentation, not execution coverage. Check /clients/status.json for actual native qualification. No generic HTTP, arbitrary shell, billing or mailbox-content tools.\n`;
  return `# Infomaniak MCP\n\nIndependent, unofficial MCP service operated by Léon Houlier.\nWebsite: ${origin.origin}\nMCP: ${new URL("/mcp", origin).href}\n\n## Current hosted scope\nRead-only account and product inventory for one explicitly approved account. Public API catalogue search and browsing. Six read-only tools: ${HOSTED_TOOLS.join(", ")}. ${writesEnabled ? "New registrations offer infomaniak:read and infomaniak:write:disposable-dns by default. Read-only remains available. Explicit domain consent permits only TXT create/update/delete at _infomaniak-ai-test. Every exact plan needs independent confirmation in a supported MCP client, with browser review as the fallback and for JSON API calls. No other DNS, mail, VPS or deployment writes." : "No hosted writes, SSH, application deployment or mailbox contents."} Catalogue coverage does not imply executable coverage. Native client onboarding remains under qualification.\n\n## Authentication\nOAuth authorization code with S256 PKCE and dynamic client registration. Customers enter their own Infomaniak token on the private browser consent page. The AI client receives a separate credential. Never request or paste a provider token in chat or a public issue.\n\n## References\n- [API documentation](${origin.origin}/api)\n- [Capabilities JSON](${origin.origin}/api/capabilities)\n- [Claude setup](${origin.origin}/clients/claude)\n- [ChatGPT setup](${origin.origin}/clients/chatgpt)\n- [Grok setup](${origin.origin}/clients/grok)\n- [Privacy](${origin.origin}/privacy)\n- [Cookies](${origin.origin}/cookies)\n- [Source](${SOURCE})\n- [Author](https://leonhoulier.com)\n\nThe repository also contains a separate policy edition with independently approved writes. ${writesEnabled ? "Only the limited disposable TXT workflow is enabled here; the broader policy operations are not." : "Those operations are not enabled on this hosted endpoint."}\n`;
}
