---
name: connect
description: Set up or check the hosted Infomaniak connection after installation. Use when connecting an account, checking permissions, or discovering which services this connection can manage.
---

# Connect Infomaniak

Discover the bundled Infomaniak MCP tools and call `infomaniak_status`.

If authentication is missing, use the host application's connection or sign-in
flow for `https://infomaniak-mcp.com/mcp`. The user enters their own Infomaniak
token on the service's private browser consent page, chooses an account and
selects resources. Never ask for tokens, passwords, cookies or 2FA in chat.
Never put credentials in tool arguments or plugin configuration.

Explain the trust boundary: this is an independent service. It encrypts the
provider token at rest; its operator holds the encryption key and can use that
token to make provider requests. The AI application receives a separate OAuth
credential. The user can inspect permissions and disconnect through the service.
See [privacy](https://infomaniak-mcp.com/privacy).

Once connected, read `accounts.list`, then `products.list` for the account
returned by this hosted connection. Use observations, not sample identifiers.
Explain the available services and effective permissions in plain language.
Read and write are offered during setup; the user can choose read-only.
Never treat setup consent as approval for a specific write.

Suggest one relevant next task using the user's observed services: inspect DNS,
check mailbox settings, find a current Manager guide, or inspect a paired VPS app.
Do not create resources or widen access as part of onboarding.

Keep connection, permission checks and completed changes distinct. If the host
cannot load the tools, link to the [client guides](https://infomaniak-mcp.com/#setup)
and report the actual limitation. Do not claim that installation proves a
successful authenticated tool call.
