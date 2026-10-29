# Try the hosted experience privately

The [public pilot](https://infomaniak-mcp.com) is online. Its MCP URL
is `https://infomaniak-mcp.com/mcp`. You can also test its browser consent
and MCP discovery flow privately on your computer. This temporary preview
does not publish anything or change your AI app settings. The production product
remains a shared service; local preview is a development and testing tool.

Requires Node.js 22.13+ and the source checkout. From `infomaniak-ai`, install
dependencies once with `npm ci --ignore-scripts` if needed.

## Demo account

```sh
npm run preview
```

Open [the private test page](http://127.0.0.1:8790). Click **Try demo connection**,
then enter the example token displayed on the page:

```text
demo-infomaniak-token-for-local-preview
```

Choose **My demo account**, then **Allow read-only access**. The result should
show six tools, writes disabled, and example domain, Mail Service and VPS
products. A standard MCP SDK client makes these reads; this is not a static
success screen. Open **Manage connection**, disconnect, and confirm that there
are no active connections.

The [homepage preview](http://127.0.0.1:8789) shows the shared-service onboarding
and each AI app's connection guide. Demo mode accepts only the displayed example
token and makes no Infomaniak requests. Other tokens are refused.

## Your own account

Start a separate, explicitly live preview:

```sh
npm run preview -- --live --port 8889
```

Open [the private account test](http://127.0.0.1:8890). Its banner must say
**Private account test**. Click **Test my account** and enter your Infomaniak API
token in the browser password field. Use the `accounts` scope and the product
read permission required for inventory; never paste the token in chat or a
command. Choose the account you want to test and allow read-only discovery.

Compare the account name/ID and returned product names/IDs with Infomaniak
Manager for that same account. Missing products may reflect permissions or API
coverage; an empty result is not proof that the Manager has no services.
This edition lists account/product inventory. It does not inspect mailbox
contents, run SSH probes, read VPS guest metrics or enable hosted writes.

The result page displays data returned through the actual hosted MCP connection.
The test driver substitutes for the AI app and keeps its OAuth credentials in
memory. It never sends your token or inventory to an AI platform. Provider
requests use the existing GET-only public API transport. No credential is read
from inherited environment settings, printed, or placed in a URL.

The gateway and test driver listen only on `127.0.0.1`. Provider credentials use
a temporary encrypted vault whose key stays in memory. Disconnect in the browser
and stop the command with **Ctrl+C** to remove the vault. A forced kill/crash can
leave encrypted temporary files, but the memory-only key cannot be recovered
after exit. Preview connections are deliberately not durable.

If the default ports are occupied, `--port 8989` uses gateway port 8989 and test
page port 8990. Do not expose either preview port to the internet or put the
preview behind a tunnel.

## Native AI apps and release checks

ChatGPT, Claude web and Grok web cannot reach a server on your computer's
loopback address. Their native onboarding uses the public HTTPS endpoint above.
The private test is evidence for consent and MCP discovery, not native app
certification. Follow [hosted deployment and qualification](hosted.md) for that
next stage.

Run the automated fixture suite with `npm test`. It uses synthetic accounts and
temporary targets, including demo refusal, complete consent/MCP reads,
disconnect and cleanup. A successful fixture run does not prove live API or
native platform compatibility.

The visual direction takes cues from [Infomaniak's website](https://www.infomaniak.com/en):
blue accents, white surfaces and restrained shapes. The project uses its own
text identity and system fonts, with a visible independent/unofficial label.
