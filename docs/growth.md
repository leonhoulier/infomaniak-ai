# First-task rollout

Start with one useful task: a read-only audit of an Infomaniak-hosted DNS zone.
The homepage and the English/French Claude Code guide use the same prompt. Keep
the other clients and supported DNS, mail and VPS workflows available.

The next learning milestone is five independent customers completing a real
task, with three returning the following week. This is a target, not a usage
claim. Operator and reviewer tests do not count toward it.

## What the counts mean

Optional server-side PostHog events include:

| Event                                          | Meaning                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `homepage_viewed`, `guide_viewed`              | Page requests, including possible bots/reloads; not visitors                                |
| `connection_started`                           | A private consent form was opened, once per setup request                                   |
| `setup_token_accepted`, `setup_token_rejected` | Token/account checks, each once per setup request                                           |
| `connection_approved`                          | One account was approved, labelled with access category                                     |
| `connection_activated`                         | The connection's first successful `infomaniak_read`, labelled with a fixed operation name   |
| `tool_completed`, `tool_failed`                | One handler outcome for every registered MCP tool, including documentation and write tools  |
| `write_verified`, `write_not_verified`         | A returned plan was observed as verified, or failed/unknown; deduplicated by event and plan |
| `connection_disconnected`                      | Browser connection revocation                                                               |
| `weekly_active_connections`                    | A closed ISO week's count of connections with at least one successful tool call             |

Completed tools are not verified writes. Write observations include MCP results,
not every JSON API or background runner transition. First activation can be an
account or product read; it is not proof a DNS audit was completed. Several
connections can belong to the same person. No stable visitor/connection identity
is sent to PostHog, so these counts cannot establish unique users, conversion,
cohort retention or the five-customer milestone. Confirm task completion and
return visits through voluntary feedback.

Only fixed labels leave the service. No account IDs, domains, addresses, tokens,
prompts, payloads, raw referrers or IPs are included. Each event gets a fresh
random ID. GPC/DNT suppress counts and local activity markers. Use GPC/DNT on
operator browser requests and test clients, including anonymous setup steps.

Set `INFOMANIAK_ANALYTICS_EXCLUDED_ACCOUNTS` to a comma-separated list of operator
and reviewer account IDs in the private deployment environment. IDs never enter
PostHog. Known excluded accounts contribute no subsequent events or activity;
pre-account visits/check failures cannot be retroactively identified. An invalid
list disables analytics. Keep the environment file outside source control.

Individual events share a 1,000-per-UTC-day budget. The encrypted store keeps
hashed setup/activation markers for the setup/connection lifetime and write
markers for 15 days. Weekly identifiers change each week, cap at 10,000
connections and expire within 21 days. A later eligible event sends each closed
week once and deletes that week's markers. Weekly totals bypass the daily event
cap. Read the `connections` property as a sum, not the number of aggregate
events. Totals are best-effort: process/transport failure, a long quiet period or
expired retention can lose them. Telemetry errors do not change tool responses.

## Five-customer invitation — draft, not sent

Choose people who already use Infomaniak domains and an AI coding tool. Ask for
permission for a short test; never request their token or full DNS zone.

> I built an independent, open-source MCP connection for Infomaniak. Would you
> try a read-only DNS audit on one of your domains? Setup starts at
> https://infomaniak-mcp.com/guides/claude-code. Your API token goes into the
> private connection page, never into chat. Naming a domain permits change
> previews, but each write still needs your confirmation. I’d like to know where
> setup gets confusing and whether the findings help. No need to share the
> token, your DNS records or screenshots of private settings.

> J’ai créé une connexion MCP indépendante et open source pour Infomaniak.
> Accepterais-tu de tester un audit DNS en lecture seule sur l’un de tes domaines ?
> Le guide est ici : https://infomaniak-mcp.com/fr/guides/claude-code. Le jeton API
> se saisit sur la page privée de connexion, jamais dans le chat. Autoriser un
> domaine permet aussi de préparer des changements, mais chacun demande ta
> confirmation. J’aimerais savoir où la configuration bloque et si le résultat
> est utile. Inutile de partager le jeton, les enregistrements DNS ou des captures
> de paramètres privés.

After a test, ask: Which client/version? Where did you get stuck? Did the audit
finish? Was any finding useful? What would you try next? A week later, with
permission: Did you use it again, and for what task? Keep any customer notes
private and minimal; do not commit them or export them as analytics properties.

## Directory copy — prepared

**Name:** Infomaniak MCP (unofficial)

**Website:** https://infomaniak-mcp.com/

**Description:** Hosted Infomaniak DNS, mail settings and VPS app workflows for
AI coding tools. Independent, MIT licensed and open source.

**Authentication:** OAuth connects the AI client to this service. Setup requires
the customer's own Infomaniak API token, entered privately on the consent page.
It is encrypted at rest; the operator holds the encryption key. This is not
Infomaniak SSO. Never request a provider token in chat or client JSON.

**Evidence:** https://infomaniak-mcp.com/clients — client/version-specific proof,
not a universal compatibility claim. Public downloads and repository installs
are separate from approved marketplace listings. A fresh-client walkthrough
recording and executed review cases remain pending; do not supply a placeholder
as a real recording or claim draft cases passed.

The ClaudeRules listing currently points its website link at GitHub. Correct it
to the website above when publisher access is available. The MCP Registry
already carries the correct website URL. Search Console indexing and query
evidence require access to this domain's actual property; unrelated connected
properties cannot establish this site's search performance.
