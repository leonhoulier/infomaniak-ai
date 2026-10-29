# Monitoring

## Availability

Monitor `/healthz` and `/.well-known/oauth-authorization-server` over HTTPS with
certificate verification. Check the health response's `ok` value and the OAuth
metadata's issuer and S256 support. Availability does not establish authenticated
provider access or successful writes.

A separate Uptime Kuma installation can check these routes and send alerts to a
destination chosen by its operator. Keep its administrator credentials, SMTP
credentials and notification destination outside the source repository. Restrict
its management interface to a private network or authenticated tunnel. Test alert
delivery; saving a notification configuration does not prove receipt.

## Optional product counts

Server-side PostHog counts are optional. Missing `POSTHOG_PROJECT_TOKEN` or
`POSTHOG_HOST` disables analytics. Configure a dedicated project through the
private operator environment. The application does not load a checkout `.env`.

The implementation uses an event allowlist, sanitized properties, fresh event
identifiers and an encrypted daily counter. It excludes provider tokens, OAuth
credentials, account identifiers, resource names, tool arguments and results.
It does not use browser autocapture, session replay or analytics cookies.
Review `src/hosted-analytics.ts` and the public privacy policy before changing
the event schema.

The service caps capture at 1,000 events per UTC day and bounds the SDK queue and
request timeout. Delivery failures do not block the application. Counts are not
unique people or per-user funnels. A service-level event cap is not an
organization-wide spending cap; check the account's current plan and shared
usage before enabling analytics.

Monitor disk space, memory, certificate renewal, backup success and restore
ability alongside HTTP checks. Keep alert delivery and operational logs private.
