import type { Express, Request } from "express";
import { page, escapeHtml as e, FIRST_PROMPT, claudeCommand } from "./hosted-pages.js";

export type Lang = "en" | "fr";
export type GuideKey = "claude-code" | "dns-records" | "vps-deploy";
const KEYS: GuideKey[] = ["claude-code", "dns-records", "vps-deploy"];
const UPDATED = { en: "Updated 19 November 2026", fr: "Mis à jour le 19 novembre 2026" };
const TOKEN_GUIDE =
  "https://www.infomaniak.com/en/support/faq/2582/add-and-manage-infomaniak-api-tokens";

export const guidePath = (lang: Lang, key?: GuideKey) =>
  (lang === "fr" ? "/fr" : "") + "/guides" + (key ? "/" + key : "");
export const GUIDE_PATHS = (["en", "fr"] as const).flatMap((lang) => [
  guidePath(lang),
  ...KEYS.map((key) => guidePath(lang, key)),
]);

const ui = {
  en: {
    copy: "Copy",
    copied: "Copied",
    manual: "Select and copy",
    other: "Version française",
    otherLang: "fr" as Lang,
    index: "All guides",
    next: "Related guides",
    setup: "Setup for other AI apps",
  },
  fr: {
    copy: "Copier",
    copied: "Copié",
    manual: "Sélectionner et copier",
    other: "English version",
    otherLang: "en" as Lang,
    index: "Tous les guides",
    next: "Guides associés",
    setup: "Configuration pour d’autres applications IA",
  },
};
function copyBlock(lang: Lang, id: string, text: string, label: string): string {
  const t = ui[lang];
  return `<div class="copy-row"><code id="${id}">${e(text)}</code><button type="button" class="copy-button" data-copy="${id}" data-copy-label="${e(t.copy)}" data-copied="${e(t.copied)}" data-manual="${e(t.manual)}" aria-label="${e(label)}">${e(t.copy)}</button></div>`;
}
const code = (text: string) => `<code>${e(text)}</code>`;
const ic = (text: string) => `<code class="inline-code">${e(text)}</code>`;

interface Guide {
  title: string;
  description: string;
  summary: string;
  body: (endpoint: string) => string;
}
const auditFindings = {
  en: [
    [
      "spf_missing / spf_multiple / spf_allows_all",
      "No SPF, duplicate SPF, or an SPF that ends in +all.",
    ],
    ["spf_missing_infomaniak", "MX points to Infomaniak but SPF lacks include:spf.infomaniak.ch."],
    [
      "dmarc_missing / dmarc_monitor_only",
      "No DMARC record at _dmarc, or a p=none policy that rejects nothing.",
    ],
    [
      "dkim_delegated / dkim_not_found",
      "_domainkey is delegated by NS, or no DKIM record was found in the zone.",
    ],
    [
      "mx_missing / apex_cname / low_ttl",
      "No MX at the apex, a CNAME at the apex, or records with a TTL under 300 s.",
    ],
  ],
  fr: [
    [
      "spf_missing / spf_multiple / spf_allows_all",
      "Pas de SPF, plusieurs SPF, ou un SPF qui se termine par +all.",
    ],
    [
      "spf_missing_infomaniak",
      "Le MX pointe vers Infomaniak mais le SPF n’inclut pas include:spf.infomaniak.ch.",
    ],
    [
      "dmarc_missing / dmarc_monitor_only",
      "Pas d’enregistrement DMARC à _dmarc, ou une politique p=none qui ne rejette rien.",
    ],
    [
      "dkim_delegated / dkim_not_found",
      "_domainkey est délégué par NS, ou aucun enregistrement DKIM n’est présent dans la zone.",
    ],
    [
      "mx_missing / apex_cname / low_ttl",
      "Pas de MX à l’apex, un CNAME à l’apex, ou des enregistrements avec un TTL inférieur à 300 s.",
    ],
  ],
};
const findingsList = (lang: Lang) =>
  `<dl class="tool-list">${auditFindings[lang].map(([k, v]) => `<dt>${ic(k!)}</dt><dd>${e(v)}</dd>`).join("")}</dl>`;

const GUIDES: Record<Lang, Record<GuideKey, Guide>> = {
  en: {
    "claude-code": {
      title: "Connect Infomaniak to Claude Code",
      description:
        "Add the hosted Infomaniak MCP server to Claude Code with one command, create a private API token, approve one account and run a read-only DNS and email-authentication audit.",
      summary: "One command, a private API token, then a read-only DNS audit of your domain.",
      body: (endpoint) => `
<p class="lead">Add the hosted server with one command, sign in through your browser, then ask for a read-only audit of your domain’s DNS and email authentication. You do not install or host a server.</p>
<section class="section"><h2>What you need</h2><ul>
<li>Claude Code, signed in.</li>
<li>An Infomaniak account with at least one domain whose DNS zone is hosted by Infomaniak.</li>
<li>An Infomaniak API token that you create yourself (step 3). You enter it only on this service’s private browser page, never in Claude.</li></ul></section>
<section class="section"><h2>1. Add the server</h2>${copyBlock("en", "guide-claude-command", claudeCommand(endpoint), "Copy Claude Code command")}
<p>This adds a private, local-scope server for this project; it does not write a shared project configuration. Add ${ic("--scope user")} before ${ic("infomaniak")} to use it in every project.</p></section>
<p><a href="https://code.claude.com/docs/en/mcp" target="_blank" rel="noopener noreferrer">Official Claude Code MCP documentation</a>.</p><section class="section"><h2>2. Start sign-in</h2><p>In Claude Code, run ${ic("/mcp")}, select <strong>infomaniak</strong> and choose to authenticate. Your browser opens this service’s private connection page.</p></section>
<section class="section"><h2>3. Create an API token in Infomaniak</h2><p>Follow <a href="${TOKEN_GUIDE}" target="_blank" rel="noopener noreferrer">Infomaniak’s guide to API tokens</a>. Give the token the accounts scope and the domain and DNS permissions for the audit. Leave out products you will not use. Store it in your password manager; you can revoke it in Infomaniak at any time.</p>
<p class="notice">Never paste the token into Claude, a terminal command or an issue. The service encrypts it; its operator holds the encryption key and can use the token for the API requests you ask for. Claude receives a separate OAuth credential. See <a href="/privacy">privacy</a>.</p></section>
<section class="section"><h2>4. Approve one account and your domain</h2><ol class="instructions">
<li>Paste the token into the password field and select <strong>Find my accounts</strong>.</li>
<li>Choose the account to share.</li>
<li>Under <strong>Domains for DNS management</strong>, enter the domain to audit, for example ${ic("example.com")}.</li>
<li>Select <strong>Allow selected access</strong>. The browser returns you to Claude Code.</li></ol>
<p>The audit only reads. The DNS audit operation is available only for domains named on this page. Naming a domain also lets Claude prepare DNS changes, but nothing changes unless you confirm one specific change. If you uncheck <strong>Allow changes to the resources below</strong>, the connection is read-only: it can list your services but cannot run the DNS audit.</p></section>
<section class="section" id="first-task"><h2>5. Run the audit</h2><p>Replace ${ic("example.com")} with the domain you approved:</p>${copyBlock("en", "guide-first-prompt", FIRST_PROMPT.en, "Copy first prompt")}
<p>Claude calls ${ic("infomaniak_status")}, then ${ic("infomaniak_read")} with the ${ic("dns.audit")} operation. It reads your stored zone and returns findings such as:</p>${findingsList("en")}
<p>It reads the zone; it does not test mail delivery or DKIM signing. To inspect or change a record next, see <a href="${guidePath("en", "dns-records")}">inspect and safely change a DNS record</a>.</p></section>
<section class="section"><h2>Plugin alternative</h2><p>The plugin adds the same connection with two skills for connection checks and Infomaniak workflows:</p>${code("claude plugin marketplace add leonhoulier/infomaniak-ai\nclaude plugin install infomaniak@infomaniak-mcp")}<p>This installs from the project’s GitHub repository. It is not a listing in Claude’s official directory.</p></section>
<section class="section"><h2>Disconnect</h2><p>Open <a href="/connections">Manage connection</a> in the browser you used to approve access and select <strong>Disconnect and delete token</strong>. You can also revoke the token in Infomaniak. To remove the server from Claude Code, run ${ic("claude mcp remove infomaniak")}.</p></section>
<section class="section"><h2>Limits</h2><ul><li>One account per connection; only the domains and mailboxes you name.</li><li>No mailbox content, billing, purchases, generic API calls or shell commands.</li><li>Client compatibility is recorded on the <a href="/clients">client compatibility page</a>; it lists what has and has not been checked for each client.</li></ul></section>`,
    },
    "dns-records": {
      title: "Inspect and safely change an Infomaniak DNS record",
      description:
        "List, audit and check propagation of Infomaniak DNS records from your AI client, then create, update or delete one record with an exact preview and your confirmation.",
      summary: "Read records, audit and propagation, then one previewed change you confirm.",
      body: () => `
<p class="lead">Read a zone, check what resolvers see, then make one change. Every change is a preview first. Nothing is sent to Infomaniak until you confirm that exact preview.</p>
<section class="section"><h2>Before you start</h2><p>Connect with the domain named under <strong>Domains for DNS management</strong> on the consent page. If you have not connected yet, follow <a href="${guidePath("en", "claude-code")}">connect Infomaniak to Claude Code</a> or the <a href="/#setup">setup for other AI apps</a>. A connection only covers the domains you named; add another domain by connecting again.</p></section>
<section class="section"><h2>Inspect</h2><dl class="tool-list">
<dt>${ic("dns.records.list")}</dt><dd>Every record in the zone. The apex appears as source ${ic(".")}; MX priority is part of the target (${ic("10 mx.example.com")}); TXT targets may keep their quotes.</dd>
<dt>${ic("dns.audit")}</dt><dd>SPF, DMARC, DKIM, MX, apex CNAME and low TTL findings from the stored zone.</dd>
<dt>${ic("dns.propagation")}</dt><dd>Asks Google, Cloudflare and Quad9 for one name and type and compares their answers with the zone. A failed lookup counts as disagreement. Agreement is not proof of global propagation; caches keep old values until their TTL expires.</dd>
<dt>${ic("domains.expiry")}</dt><dd>Registration expiry date in UTC and days left.</dd></dl>
<p>Example: <em>“List the DNS records of example.com, then check what public resolvers return for www as an A record.”</em></p></section>
<section class="section"><h2>Change one record</h2><dl class="tool-list">
<dt>${ic("dns.record.create")}</dt><dd>Source, type (A, AAAA, CNAME, MX, TXT, SRV, CAA or NS), target and TTL between 60 and 86,400 seconds.</dd>
<dt>${ic("dns.record.update")}</dt><dd>Target and TTL of an existing record, by record ID. Changing the source or type needs a delete and a create.</dd>
<dt>${ic("dns.record.delete")}</dt><dd>One existing record, by record ID.</dd></dl>
<p>Ask for the change and the confirmation in the same request:</p>${copyBlock("en", "guide-dns-prompt", "In example.com, prepare a TXT record at _verify with the value site-check-123 and a TTL of 3600. Show me the preview and wait for my confirmation.", "Copy example prompt")}
<ol class="instructions">
<li><strong>Preview.</strong> The AI calls ${ic("infomaniak_plan")}. This reads the current state and stores a plan; it makes no change in Infomaniak. The plan shows the account, zone, record, the records before and after, the impact and the recovery steps.</li>
<li><strong>Confirm.</strong> If the plan says ${ic("approval_method: client")}, the AI calls ${ic("infomaniak_execute")} and your client shows its own confirmation dialog with the same details. If it says ${ic("browser")}, open the ${ic("approval_url")} in the browser where you connected, check the before and after values and type APPROVE.</li>
<li><strong>Execute and verify.</strong> After confirmation, the change is sent once. ${ic("verified")} means Infomaniak’s readback matches the plan. It does not prove public propagation; check with ${ic("dns.propagation")}.</li></ol>
<p>Plans expire. If the zone changes after the preview, the plan cannot execute; ask for a fresh preview. If the outcome is ${ic("unknown")}, do not repeat the change: ask the AI to call ${ic("infomaniak_operation")} with ${ic("refresh: true")} to read back the result. Before execution starts, decline or cancel with ${ic("infomaniak_cancel")} or the Cancel button.</p></section>
<section class="section"><h2>Undo a change</h2><p>Open the <a href="/operations">operations page</a> in the browser where you connected, select the verified change and choose <strong>Prepare a recovery plan</strong>. This prepares the inverse change, for example deleting the record you created, as a new preview that needs its own approval. Nothing is restored silently.</p></section>
<section class="section"><h2>Limits</h2><ul><li>Only record reads and the three record changes above, in domains you named.</li><li>No zone creation, transfer or registration changes.</li><li>DNS changes can affect websites, mail and service verification. Read the impact line in every preview.</li></ul></section>`,
    },
    "vps-deploy": {
      title: "Deploy and roll back a stateless app on an Infomaniak VPS",
      description:
        "Pair a customer-owned runner on your Infomaniak VPS, deploy a pinned Git commit of a stateless Dockerfile app from your AI client, and roll back to the retained previous release.",
      summary: "Pair your own runner, deploy a pinned commit, and roll back to the previous image.",
      body: () => `
<p class="lead">A runner you install on your own VPS builds and serves your app. Your AI prepares each deployment or rollback as a preview, and the runner acts only after you confirm it. SSH keys and app environment files stay on the VPS.</p>
<section class="section"><h2>Requirements</h2><ul>
<li>A VPS with Node.js 22.13 or later and Docker.</li>
<li>A stateless HTTP app with a Dockerfile, in a Git repository reachable over HTTPS without credentials.</li>
<li>A hostname for the app that points to the VPS. To add the record, see <a href="${guidePath("en", "dns-records")}">change a DNS record</a>.</li>
<li>For the built-in Nginx adapter: Nginx, certbot, an existing ACME account and permission to install the runner’s route and reload Nginx. With another reverse proxy, use ${ic("--proxy external")}.</li>
<li>A connection with <strong>Allow deployment on runners I pair and approve in this browser</strong> checked on the consent page.</li></ul></section>
<section class="section"><h2>1. Install the runner on the VPS</h2><p>The <a href="/downloads">runner download page</a> shows the install command for the current version and its SHA-256 checksum. Compare the checksum with <a href="/releases/latest.json">the release manifest</a> before installing.</p></section>
<section class="section"><h2>2. Create and pair a runner</h2><p>Use a new private directory outside your repository:</p>${code("infomaniak-ai runner init --directory /home/USER/.config/infomaniak-runner --name my-app --repository https://github.com/OWNER/REPO.git --hostname app.example.com --proxy nginx\ninfomaniak-ai runner pair --directory /home/USER/.config/infomaniak-runner\ninfomaniak-ai runner run --directory /home/USER/.config/infomaniak-runner")}
<p>Optional flags: ${ic("--dockerfile")} and ${ic("--build-context")} for a monorepo, ${ic("--container-port")} (default 3000), ${ic("--health-path")} (default /) and ${ic("--env-file")} for a private environment file on the VPS. With ${ic("--proxy external --port PORT")}, your proxy handles public TLS and the runner reports loopback health only.</p>
<p>${ic("runner pair")} prints a pairing link. Open it in the browser where you connected your AI and check the app name, repository and hostname before approving. Keep ${ic("runner run")} running, for example as a service you manage.</p></section>
<section class="section"><h2>3. Deploy a pinned commit</h2>${copyBlock("en", "guide-deploy-prompt", "Inspect my paired app my-app with deployment.app.get, then prepare deployment.release for commit 0123456789abcdef0123456789abcdef01234567. Show me the preview and wait for my confirmation.", "Copy deployment prompt")}
<p>Replace the commit with a full 40-character SHA from your repository. The preview states that the repository’s build code runs on your VPS. After you confirm, the runner builds the image, health-checks the new container before routing traffic, switches the route and checks public health. The AI follows progress with ${ic("infomaniak_operation")}. ${ic("deployment.runner.health")} returns CPU, load, memory, uptime and app health. ${ic("deployment.logs")} requests the last 100 log lines; read them with ${ic("deployment.job.get")}.</p></section>
<section class="section"><h2>4. Roll back</h2><p>Ask: <em>“Prepare deployment.rollback for my-app and wait for my confirmation.”</em> The runner restores the retained previous image after you confirm this separate plan. Rollback is only available after at least one earlier successful release. It does not restore databases, migrations or other external data.</p></section>
<section class="section"><h2>If the runner stops mid-deployment</h2><p>Stop the old runner process and inspect its output. Remove only its stale ${ic("runner.lock")}, then run ${ic("infomaniak-ai runner reconcile --directory DIR --job UUID")}. It reads owned containers and health endpoints without rebuilding, restarting or switching a route. An ambiguous result stays unknown and locked.</p></section>
<section class="section"><h2>Limits</h2><ul><li>Stateless HTTP Dockerfile apps from public HTTPS repositories; no private Git credentials.</li><li>No shell access, database migrations, persistent volume recovery or VPS reinstallation.</li><li>Logs are sent only when you ask for them and are scrubbed using the values in the app’s environment file. Secrets the app prints from elsewhere may remain.</li></ul></section>`,
    },
  },
  fr: {
    "claude-code": {
      title: "Connecter Infomaniak à Claude Code",
      description:
        "Ajoutez le serveur MCP Infomaniak hébergé à Claude Code en une commande, créez un jeton API privé, autorisez un compte et lancez un audit DNS et d’authentification e-mail en lecture seule.",
      summary:
        "Une commande, un jeton API privé, puis un audit DNS en lecture seule de votre domaine.",
      body: (endpoint) => `
<p class="lead">Ajoutez le serveur hébergé en une commande, connectez-vous dans votre navigateur, puis demandez un audit en lecture seule du DNS et de l’authentification e-mail de votre domaine. Aucun serveur à installer ni à héberger.</p>
<section class="section"><h2>Ce qu’il vous faut</h2><ul>
<li>Claude Code, connecté à votre compte.</li>
<li>Un compte Infomaniak avec au moins un domaine dont la zone DNS est hébergée chez Infomaniak.</li>
<li>Un jeton API Infomaniak que vous créez vous-même (étape 3). Vous le saisissez uniquement sur la page privée de ce service, jamais dans Claude.</li></ul></section>
<section class="section"><h2>1. Ajouter le serveur</h2>${copyBlock("fr", "guide-claude-command", claudeCommand(endpoint), "Copier la commande Claude Code")}
<p>Le serveur est ajouté au scope local privé de ce projet ; aucune configuration partagée n’est écrite dans le dépôt. Ajoutez ${ic("--scope user")} avant ${ic("infomaniak")} pour l’utiliser dans tous vos projets.</p></section>
<p><a href="https://code.claude.com/docs/en/mcp" target="_blank" rel="noopener noreferrer" lang="en">Documentation officielle MCP de Claude Code (en anglais)</a>.</p><section class="section"><h2>2. Lancer la connexion</h2><p>Dans Claude Code, tapez ${ic("/mcp")}, sélectionnez <strong>infomaniak</strong> et choisissez l’authentification. Votre navigateur ouvre la page de connexion privée de ce service.</p></section>
<section class="section"><h2>3. Créer un jeton API chez Infomaniak</h2><p>Suivez <a href="${TOKEN_GUIDE}" target="_blank" rel="noopener noreferrer">le guide Infomaniak sur les jetons API</a> (en anglais). Donnez au jeton le scope accounts et les autorisations domaine et DNS nécessaires à l’audit. N’ajoutez pas les produits que vous n’utiliserez pas. Conservez-le dans votre gestionnaire de mots de passe ; vous pouvez le révoquer à tout moment chez Infomaniak.</p>
<p class="notice">Ne collez jamais le jeton dans Claude, dans une commande ou dans un ticket. Le service le chiffre ; son exploitant détient la clé de chiffrement et peut utiliser le jeton pour les requêtes API que vous demandez. Claude reçoit un identifiant OAuth distinct. Voir la <a href="/privacy">politique de confidentialité</a> (en anglais).</p></section>
<section class="section"><h2>4. Autoriser un compte et votre domaine</h2><ol class="instructions">
<li>Collez le jeton dans le champ mot de passe et choisissez <strong lang="en">Find my accounts</strong>.</li>
<li>Choisissez le compte à partager.</li>
<li>Sous <strong lang="en">Domains for DNS management</strong>, saisissez le domaine à auditer, par exemple ${ic("example.com")}.</li>
<li>Choisissez <strong lang="en">Allow selected access</strong>. Le navigateur vous renvoie vers Claude Code.</li></ol>
<p>L’audit ne fait que lire. L’opération d’audit DNS n’est disponible que pour les domaines saisis sur cette page. Saisir un domaine permet aussi à Claude de préparer des modifications DNS, mais rien ne change sans votre confirmation d’une modification précise. Si vous décochez <strong lang="en">Allow changes to the resources below</strong>, la connexion est en lecture seule : elle liste vos services mais ne peut pas lancer l’audit DNS.</p></section>
<section class="section" id="first-task"><h2>5. Lancer l’audit</h2><p>Remplacez ${ic("example.com")} par le domaine autorisé :</p>${copyBlock("fr", "guide-first-prompt", FIRST_PROMPT.fr, "Copier la première demande")}
<p>Claude appelle ${ic("infomaniak_status")}, puis ${ic("infomaniak_read")} avec l’opération ${ic("dns.audit")}. Il lit la zone enregistrée et renvoie des constats comme :</p>${findingsList("fr")}
<p>L’audit lit la zone ; il ne teste ni la distribution du courrier ni la signature DKIM. Pour inspecter ou modifier un enregistrement ensuite, voir <a href="${guidePath("fr", "dns-records")}">inspecter et modifier un enregistrement DNS en sécurité</a>.</p></section>
<section class="section"><h2>Alternative : le plugin</h2><p>Le plugin ajoute la même connexion avec deux skills, pour vérifier la connexion et pour les tâches Infomaniak :</p>${code("claude plugin marketplace add leonhoulier/infomaniak-ai\nclaude plugin install infomaniak@infomaniak-mcp")}<p>L’installation se fait depuis le dépôt GitHub du projet. Ce n’est pas une fiche dans le répertoire officiel de Claude.</p></section>
<section class="section"><h2>Se déconnecter</h2><p>Ouvrez <a href="/connections">Manage connection</a> dans le navigateur utilisé pour l’autorisation et choisissez <strong lang="en">Disconnect and delete token</strong>. Vous pouvez aussi révoquer le jeton chez Infomaniak. Pour retirer le serveur de Claude Code : ${ic("claude mcp remove infomaniak")}.</p></section>
<section class="section"><h2>Limites</h2><ul><li>Un compte par connexion ; uniquement les domaines et boîtes mail que vous nommez.</li><li>Pas d’accès au contenu des e-mails, à la facturation, aux achats, à des appels API génériques ni à des commandes shell.</li><li>La compatibilité de chaque client est documentée sur la <a href="/clients">page de compatibilité</a> (en anglais), avec ce qui a été vérifié ou non.</li></ul></section>`,
    },
    "dns-records": {
      title: "Inspecter et modifier un enregistrement DNS Infomaniak en sécurité",
      description:
        "Listez, auditez et vérifiez la propagation de vos enregistrements DNS Infomaniak depuis votre client IA, puis créez, modifiez ou supprimez un enregistrement avec un aperçu exact et votre confirmation.",
      summary:
        "Lire, auditer, vérifier la propagation, puis une modification prévisualisée que vous confirmez.",
      body: () => `
<p class="lead">Lisez une zone, vérifiez ce que voient les résolveurs, puis effectuez une modification. Chaque modification commence par un aperçu. Rien n’est envoyé à Infomaniak avant que vous confirmiez cet aperçu exact.</p>
<section class="section"><h2>Avant de commencer</h2><p>Connectez-vous en saisissant le domaine sous <strong lang="en">Domains for DNS management</strong> sur la page d’autorisation. Si ce n’est pas encore fait, suivez <a href="${guidePath("fr", "claude-code")}">connecter Infomaniak à Claude Code</a> ou la <a href="/#setup">configuration pour d’autres applications IA</a>. Une connexion couvre uniquement les domaines saisis ; pour en ajouter un, connectez-vous à nouveau.</p></section>
<section class="section"><h2>Inspecter</h2><dl class="tool-list">
<dt>${ic("dns.records.list")}</dt><dd>Tous les enregistrements de la zone. L’apex apparaît avec la source ${ic(".")} ; la priorité MX fait partie de la cible (${ic("10 mx.example.com")}) ; les cibles TXT peuvent garder leurs guillemets.</dd>
<dt>${ic("dns.audit")}</dt><dd>Constats SPF, DMARC, DKIM, MX, CNAME à l’apex et TTL bas, à partir de la zone enregistrée.</dd>
<dt>${ic("dns.propagation")}</dt><dd>Interroge Google, Cloudflare et Quad9 pour un nom et un type, et compare leurs réponses à la zone. Un échec de requête compte comme un désaccord. Un accord ne prouve pas une propagation mondiale ; les caches conservent les anciennes valeurs jusqu’à l’expiration du TTL.</dd>
<dt>${ic("domains.expiry")}</dt><dd>Date d’expiration de l’enregistrement du domaine en UTC et nombre de jours restants.</dd></dl>
<p>Exemple : <em>« Liste les enregistrements DNS de example.com, puis vérifie ce que les résolveurs publics renvoient pour www en type A. »</em></p></section>
<section class="section"><h2>Modifier un enregistrement</h2><dl class="tool-list">
<dt>${ic("dns.record.create")}</dt><dd>Source, type (A, AAAA, CNAME, MX, TXT, SRV, CAA ou NS), cible et TTL entre 60 et 86 400 secondes.</dd>
<dt>${ic("dns.record.update")}</dt><dd>Cible et TTL d’un enregistrement existant, par son identifiant. Changer la source ou le type demande une suppression puis une création.</dd>
<dt>${ic("dns.record.delete")}</dt><dd>Un enregistrement existant, par son identifiant.</dd></dl>
<p>Demandez la modification et la confirmation dans la même requête :</p>${copyBlock("fr", "guide-dns-prompt", "Dans example.com, prépare un enregistrement TXT à _verify avec la valeur site-check-123 et un TTL de 3600. Montre-moi l’aperçu et attends ma confirmation.", "Copier l’exemple de demande")}
<ol class="instructions">
<li><strong>Aperçu.</strong> L’IA appelle ${ic("infomaniak_plan")}. L’état actuel est lu et un plan est enregistré ; aucune modification n’est effectuée chez Infomaniak. Le plan indique le compte, la zone, l’enregistrement, les enregistrements avant et après, l’impact et la marche à suivre pour revenir en arrière.</li>
<li><strong>Confirmation.</strong> Si le plan indique ${ic("approval_method: client")}, l’IA appelle ${ic("infomaniak_execute")} et votre client affiche sa propre boîte de confirmation avec les mêmes détails. S’il indique ${ic("browser")}, ouvrez l’${ic("approval_url")} dans le navigateur utilisé pour la connexion, vérifiez les valeurs avant et après et tapez APPROVE.</li>
<li><strong>Exécution et vérification.</strong> Après confirmation, la modification est envoyée une seule fois. ${ic("verified")} signifie que la relecture chez Infomaniak correspond au plan. Cela ne prouve pas la propagation publique ; vérifiez avec ${ic("dns.propagation")}.</li></ol>
<p>Les plans expirent. Si la zone change après l’aperçu, le plan ne peut plus s’exécuter ; demandez un nouvel aperçu. Si le résultat est ${ic("unknown")}, ne répétez pas la modification : demandez à l’IA d’appeler ${ic("infomaniak_operation")} avec ${ic("refresh: true")} pour relire le résultat. Avant le début de l’exécution, vous pouvez refuser ou annuler avec ${ic("infomaniak_cancel")} ou le bouton Cancel.</p></section>
<section class="section"><h2>Annuler une modification</h2><p>Ouvrez la <a href="/operations">page des opérations</a> dans le navigateur utilisé pour la connexion, sélectionnez la modification vérifiée et choisissez <strong>Prepare a recovery plan</strong>. Cela prépare la modification inverse, par exemple la suppression de l’enregistrement créé, sous forme d’un nouvel aperçu qui demande sa propre approbation. Rien n’est restauré automatiquement.</p></section>
<section class="section"><h2>Limites</h2><ul><li>Uniquement la lecture des enregistrements et les trois modifications ci-dessus, dans les domaines saisis.</li><li>Pas de création ni de transfert de zone, ni de modification de l’enregistrement du domaine.</li><li>Une modification DNS peut affecter des sites web, le courrier et la vérification de services. Lisez la ligne d’impact de chaque aperçu.</li></ul></section>`,
    },
    "vps-deploy": {
      title: "Déployer et revenir en arrière avec une app sans état sur un VPS Infomaniak",
      description:
        "Appairez un runner sur votre propre VPS Infomaniak, déployez un commit Git précis d’une app Dockerfile sans état depuis votre client IA, et revenez à la version précédente conservée.",
      summary:
        "Appairer votre propre runner, déployer un commit précis et revenir à l’image précédente.",
      body: () => `
<p class="lead">Un runner que vous installez sur votre propre VPS construit et sert votre app. Votre IA prépare chaque déploiement ou retour en arrière sous forme d’aperçu, et le runner n’agit qu’après votre confirmation. Les clés SSH et les fichiers d’environnement restent sur le VPS.</p>
<section class="section"><h2>Prérequis</h2><ul>
<li>Un VPS avec Node.js 22.13 ou plus récent et Docker.</li>
<li>Une app HTTP sans état avec un Dockerfile, dans un dépôt Git accessible en HTTPS sans identifiants.</li>
<li>Un nom d’hôte pour l’app qui pointe vers le VPS. Pour ajouter l’enregistrement, voir <a href="${guidePath("fr", "dns-records")}">modifier un enregistrement DNS</a>.</li>
<li>Pour l’adaptateur Nginx intégré : Nginx, certbot, un compte ACME existant et le droit d’installer la route du runner et de recharger Nginx. Avec un autre reverse proxy, utilisez ${ic("--proxy external")}.</li>
<li>Une connexion avec <strong lang="en">Allow deployment on runners I pair and approve in this browser</strong> coché sur la page d’autorisation.</li></ul></section>
<section class="section"><h2>1. Installer le runner sur le VPS</h2><p>La <a href="/downloads">page de téléchargement du runner</a> (en anglais) donne la commande d’installation de la version actuelle et sa somme SHA-256. Comparez-la avec le <a href="/releases/latest.json">manifeste de version</a> avant l’installation.</p></section>
<section class="section"><h2>2. Créer et appairer un runner</h2><p>Utilisez un nouveau dossier privé, hors de votre dépôt :</p>${code("infomaniak-ai runner init --directory /home/USER/.config/infomaniak-runner --name my-app --repository https://github.com/OWNER/REPO.git --hostname app.example.com --proxy nginx\ninfomaniak-ai runner pair --directory /home/USER/.config/infomaniak-runner\ninfomaniak-ai runner run --directory /home/USER/.config/infomaniak-runner")}
<p>Options : ${ic("--dockerfile")} et ${ic("--build-context")} pour un monorepo, ${ic("--container-port")} (3000 par défaut), ${ic("--health-path")} (/ par défaut) et ${ic("--env-file")} pour un fichier d’environnement privé sur le VPS. Avec ${ic("--proxy external --port PORT")}, votre proxy gère le TLS public et le runner ne vérifie que la santé en local.</p>
<p>${ic("runner pair")} affiche un lien d’appairage. Ouvrez-le dans le navigateur utilisé pour connecter votre IA et vérifiez le nom de l’app, le dépôt et le nom d’hôte avant d’approuver. Laissez ${ic("runner run")} tourner, par exemple comme un service que vous gérez.</p></section>
<section class="section"><h2>3. Déployer un commit précis</h2>${copyBlock("fr", "guide-deploy-prompt", "Inspecte mon app appairée my-app avec deployment.app.get, puis prépare deployment.release pour le commit 0123456789abcdef0123456789abcdef01234567. Montre-moi l’aperçu et attends ma confirmation.", "Copier la demande de déploiement")}
<p>Remplacez le commit par un SHA complet de 40 caractères de votre dépôt. L’aperçu précise que le code de build du dépôt s’exécute sur votre VPS. Après confirmation, le runner construit l’image, vérifie la santé du nouveau conteneur avant d’y envoyer le trafic, bascule la route et vérifie la santé publique. L’IA suit l’avancement avec ${ic("infomaniak_operation")}. ${ic("deployment.runner.health")} renvoie CPU, charge, mémoire, uptime et santé de l’app. ${ic("deployment.logs")} demande les 100 dernières lignes de journal ; lisez-les avec ${ic("deployment.job.get")}.</p></section>
<section class="section"><h2>4. Revenir en arrière</h2><p>Demandez : <em>« Prépare deployment.rollback pour my-app et attends ma confirmation. »</em> Le runner restaure l’image précédente conservée après confirmation de ce plan distinct. Le retour en arrière n’est possible qu’après au moins une version précédente réussie. Il ne restaure ni les bases de données, ni les migrations, ni les autres données externes.</p></section>
<section class="section"><h2>Si le runner s’arrête pendant un déploiement</h2><p>Arrêtez l’ancien processus du runner et consultez sa sortie. Supprimez uniquement son ${ic("runner.lock")} périmé, puis lancez ${ic("infomaniak-ai runner reconcile --directory DIR --job UUID")}. La commande lit les conteneurs gérés et les points de santé sans reconstruire, redémarrer ni basculer de route. Un résultat ambigu reste inconnu et verrouillé.</p></section>
<section class="section"><h2>Limites</h2><ul><li>Apps HTTP sans état avec Dockerfile, depuis des dépôts HTTPS publics ; pas d’identifiants Git privés.</li><li>Pas d’accès shell, de migrations de base de données, de restauration de volumes persistants ni de réinstallation du VPS.</li><li>Les journaux ne sont envoyés que sur demande et sont nettoyés à l’aide des valeurs du fichier d’environnement de l’app. Des secrets affichés par l’app depuis d’autres sources peuvent subsister.</li></ul></section>`,
    },
  },
};

const indexCopy = {
  en: {
    title: "Infomaniak MCP guides",
    heading: "Guides.",
    lead: "Step-by-step tasks with the hosted Infomaniak MCP service. Each guide lists what it needs, the exact operations it uses and where it stops.",
    description:
      "Guides for the hosted Infomaniak MCP service: connect Claude Code, audit and change DNS records, and deploy and roll back an app on an Infomaniak VPS.",
  },
  fr: {
    title: "Guides Infomaniak MCP",
    heading: "Guides.",
    lead: "Des tâches pas à pas avec le service MCP Infomaniak hébergé. Chaque guide indique ses prérequis, les opérations exactes utilisées et ses limites.",
    description:
      "Guides du service MCP Infomaniak hébergé : connecter Claude Code, auditer et modifier des enregistrements DNS, déployer et revenir en arrière sur un VPS Infomaniak.",
  },
};
function languageLink(lang: Lang, key?: GuideKey): string {
  const other = ui[lang].otherLang;
  return `<p><a href="${guidePath(other, key)}" hreflang="${other}" lang="${other}">${e(ui[lang].other)}</a></p>`;
}
const indepNote = {
  en: "Independent and unofficial; not affiliated with Infomaniak.",
  fr: "Service indépendant et non officiel ; sans lien avec Infomaniak.",
};

export function guideIndex(lang: Lang, origin: string, notice?: string): string {
  const copy = indexCopy[lang];
  return page(
    copy.title,
    `${languageLink(lang)}<h1>${e(copy.heading)}</h1><p class="lead">${e(copy.lead)}</p><ul class="result-list">${KEYS.map((key) => `<li><a href="${guidePath(lang, key)}"><strong>${e(GUIDES[lang][key].title)}</strong></a><small>${e(GUIDES[lang][key].summary)}</small></li>`).join("")}</ul><p><a href="/#setup">${e(ui[lang].setup)}</a> · <a href="/clients">${lang === "fr" ? "Compatibilité des clients" : "Client compatibility"}</a></p><small>${e(UPDATED[lang])}. ${e(indepNote[lang])}</small>`,
    notice,
    {
      origin,
      path: guidePath(lang),
      description: copy.description,
      lang,
      alternates: { en: guidePath("en"), fr: guidePath("fr") },
    },
  );
}
export function guide(
  lang: Lang,
  key: GuideKey,
  origin: string,
  endpoint: string,
  version: string,
  notice?: string,
): string {
  const g = GUIDES[lang][key];
  const related = KEYS.filter((k) => k !== key)
    .map((k) => `<li><a href="${guidePath(lang, k)}">${e(GUIDES[lang][k].title)}</a></li>`)
    .join("");
  return page(
    g.title,
    `<nav aria-label="${lang === "fr" ? "Fil d’Ariane" : "Breadcrumb"}"><p><a href="${guidePath(lang)}">${e(ui[lang].index)}</a></p></nav>${languageLink(lang, key)}<h1>${e(g.title)}</h1><small>${e(UPDATED[lang])} · ${lang === "fr" ? "service" : "service"} ${e(version)}. ${e(indepNote[lang])}</small>${g.body(endpoint)}<section class="section"><h2>${e(ui[lang].next)}</h2><ul>${related}</ul><p><a href="/#setup">${e(ui[lang].setup)}</a></p></section>`,
    notice,
    {
      origin,
      path: guidePath(lang, key),
      description: g.description,
      copy: true,
      lang,
      alternates: { en: guidePath("en", key), fr: guidePath("fr", key) },
    },
  );
}

export function mountGuides(
  app: Express,
  origin: URL,
  endpoint: string,
  version: string,
  notice: string | undefined,
  viewed: (req: Request, key: GuideKey | "index", lang: Lang) => void,
): void {
  for (const lang of ["en", "fr"] as const) {
    app.get(guidePath(lang), (req, res) => {
      viewed(req, "index", lang);
      res.type("html").send(guideIndex(lang, origin.origin, notice));
    });
    for (const key of KEYS)
      app.get(guidePath(lang, key), (req, res) => {
        viewed(req, key, lang);
        res.type("html").send(guide(lang, key, origin.origin, endpoint, version, notice));
      });
  }
}
export const GUIDE_TITLES = Object.fromEntries(
  KEYS.map((key) => [key, GUIDES.en[key].title]),
) as Record<GuideKey, string>;
