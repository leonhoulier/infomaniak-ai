# Website design

The October 2026 refinement keeps the Infomaniak blue and makes connection
setup the first task on the page. It uses the existing server-rendered HTML,
shared CSS and small copy helper; no frontend framework was added.

- IBM Plex Sans, self-hosted in three weights under the SIL Open Font License.
  The upstream version and package integrity are in `data/fonts/provenance.json`.
- Neutral `#fafbf9` canvas, `#1b2a32` text and `#0066b3` action colour. Dark
  appearance has its own contrast colours. The appearance choice is not stored.
- Plain wordmark, flat controls and simple dividers. Capabilities are definition
  rows; detailed instructions and FAQs use native disclosures.
- The MCP URL, copy buttons, client links and Claude Code command stay near the
  main setup actions. The setup link opens the detailed instructions through a
  native fragment target. No extra JavaScript is needed for disclosure or tabs.
- Private consent, API reference, policy pages and social artwork use the same
  typography and colour palette. Product limits stay visible in the copy.

Font delivery uses an exact filename allowlist and the same origin. It does not
add a third-party font request, browser analytics or cookies. Keep future visual
changes tied to a useful action or clearer content, rather than adding decorative
badges, gradients or repeated icon cards.
