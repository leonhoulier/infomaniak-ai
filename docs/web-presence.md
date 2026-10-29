# Website, privacy and discovery

Updated 28 October 2026. This records implementation, not a ranking or compliance
certification.

## Public experience

The homepage puts the MCP URL, copy buttons, client links, Claude Code command
and API entry point in the first screen. The footer credits Léon Houlier and
links to leonhoulier.com. Copy buttons use a small first-party script permitted
by its exact CSP hash. There are no browser analytics scripts, external fonts,
replay, advertising cookies or local-storage preferences.

The later visual refinement uses self-hosted IBM Plex Sans, neutral surfaces,
flat blue actions and definition rows for capabilities. Detailed setup and tool
instructions use native disclosures. The social preview matches the page.
See [design.md](design.md) for the implemented design choices.

Privacy and cookie pages describe operator access to encrypted tokens, AI-provider
sharing, connection expiry, seven-day encrypted backups and infrastructure logs.
They distinguish the essential 10-minute sign-in cookie from the 30-day browser
management cookie. The service respects GPC and DNT on each analytics-generating
request. This is a request-level choice, not a preference automatically propagated
from a browser to a separate AI client.

The JSON API now includes read-only hosted access and an optional disposable
TXT write beta. A fresh write-scoped connection, verified domain consent and
separate browser approval are required. The policy edition retains its broader
reviewed handlers. The site distinguishes these scopes.

## Search and AI retrieval

- Page-specific titles, descriptions, canonical URLs and author metadata.
- Open Graph and Twitter metadata with a first-party 1200 x 630 PNG.
- SoftwareApplication/Person microdata matching the public product and author.
- Sitemap with eight public pages, excluding authentication and account pages.
- robots.txt plus noindex headers and markup on private/error pages. Authentication
  remains the actual access boundary; robots.txt is not a security control.
- A short `/llms.txt` reference with explicit current coverage, auth instructions
  and links. This is useful documentation, not a guarantee of AI citations.
- Public `/api/capabilities` JSON without customer data or provider calls.

No search-engine ownership verification, index submission, ranking improvement or
AI recommendation was established by these changes.

## GitHub

The public repository description, homepage and topics now point to the hosted
product. Its README leads with the URL, setup command, privacy links and a clear
hosted-versus-policy comparison. The hosted write beta is described in the README. Application source changes
were not published by the marketing update; the README states that the hosted
build is ahead of the public source release.

## References used

- [Theo Browne community skill](https://github.com/marcusrbrown/dev-like/blob/main/registry/theo/skill/develop-like-theo/SKILL.md): small TypeScript changes, delivery and maintainability; not a first-party endorsement.
- [Claude Code HTTP MCP setup](https://code.claude.com/docs/en/mcp): command syntax, followed by browser authentication.
- [Google AI features and websites](https://developers.google.com/search/docs/appearance/ai-features): ordinary SEO fundamentals apply; no special AI markup guarantees inclusion.
- [Google generated-content guidance](https://developers.google.com/search/docs/fundamentals/using-gen-ai-content): accurate, useful content and metadata.
- [CNIL cookie guidance](https://www.cnil.fr/fr/cookies-et-autres-traceurs/que-dit-la-loi): authentication and security cookies are distinct from optional advertising trackers.
