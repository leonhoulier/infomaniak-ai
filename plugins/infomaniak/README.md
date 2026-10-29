# Infomaniak MCP plugin

Manage the Infomaniak services you already run from your AI tools.
Independent, MIT licensed and open source. Built by [Léon Houlier](https://leonhoulier.com).

This plugin connects to `https://infomaniak-mcp.com/mcp`. It bundles connection
guidance and Infomaniak workflows. No local runtime, API key in plugin settings,
or customer-hosted server is required. VPS deployment is optional and requires
a separately paired runner on your own VPS.

## Install

Download a versioned archive from [the public plugin page](https://infomaniak-mcp.com/plugins), then import it in your client's plugin uploader. Use the portable ZIP
for compatible hosts, including Claude, and the OpenAI ZIP for OpenAI's uploader.
The package contains two skills and one hosted MCP connection.

You can also add `https://infomaniak-mcp.com/mcp` as a custom remote MCP server.
See the [client guides](https://infomaniak-mcp.com/clients) for setup instructions
and the exact qualification status of each client.

For development, load this folder with `claude --plugin-dir ./plugins/infomaniak`.
Claude Code can use `claude plugin marketplace add leonhoulier/infomaniak-ai`
and `claude plugin install infomaniak@infomaniak-mcp`. This repository installation
source and archive do not establish a public directory listing.

## Connect

Install the package through a supported plugin host, then use its private OAuth
sign-in flow. Choose your Infomaniak account and named resources on the browser
consent page. Enter the provider token there, never in chat. The independent
service encrypts it at rest; the operator holds the encryption key. Your AI
application receives a separate OAuth credential. You can choose read-only.

Ask: **Show my Infomaniak services and what this connection can manage.**

## Workflows

- Inspect DNS and mail authentication; prepare exact record changes and check propagation.
- Inspect mailbox settings; prepare alias and forwarding changes.
- Deploy pinned commits through a paired VPS runner and recover a retained image.
- Find current official guides for Manager tasks using your agent's browser tools.

Every supported write has a complete preview and independent confirmation. Clients
that support MCP form elicitation show their own confirmation dialog; other clients
use the private browser review. API-token entry always stays in the browser. Documentation
access does not authorize browser actions. There is no generic HTTP executor,
arbitrary shell, purchasing or mailbox-content access.

## Package formats and status

The portable ZIP uses root `plugin.json` and `mcp.json` in the portable Agent Plugins format for
compatible hosts, including OpenAI and Cursor. The Claude compatibility files
are `.claude-plugin/plugin.json` and `.mcp.json`. Both target the same hosted MCP. A separate OpenAI submission ZIP adds its
OAuth/DCR declaration. The OpenAI documentation uses a vendor extension on
MCP entries that the strict portable MCP schema currently rejects, so that
portal-specific declaration is kept out of the portable package.

Client support depends on the host and its account settings. Importing the
archive does not establish OAuth or workflow compatibility. Public directory
approval and per-client workflow qualification are separate steps. See the service's
[client evidence](https://infomaniak-mcp.com/clients).

[Website](https://infomaniak-mcp.com) · [API](https://infomaniak-mcp.com/api) ·
[Privacy](https://infomaniak-mcp.com/privacy) · [Source](https://github.com/leonhoulier/infomaniak-ai)

## Contribute

Small fixes, client reports and documented Infomaniak operations are welcome.
See [the contribution guide](https://github.com/leonhoulier/infomaniak-ai/blob/main/CONTRIBUTING.md). Never include credentials or customer data in an issue.
