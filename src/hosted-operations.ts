import type { Express, Request } from "express";
import { z } from "zod";
import { HostedStore, fingerprint } from "./hosted-store.js";
import { HostedOAuth, SCOPE, WRITE_SCOPE, type Grant, type Browser } from "./hosted-oauth.js";
import { DNS_SCOPE, MAIL_SCOPE, DEPLOY_SCOPE } from "./hosted-resources.js";
import type { HostedWrites } from "./hosted-writes.js";
import type { Plan } from "./journal.js";
import { PluginError } from "./errors.js";
import { escapeHtml as e } from "./hosted-pages.js";

interface ConnectionRecord {
  owner: string;
  account: number;
  client: string;
  created: number;
}
const labels: Record<string, string> = {
  planned: "Needs review",
  approved: "Approved",
  executing: "Running",
  pending: "Awaiting verification",
  unknown: "Needs reconciliation",
  verified: "Verified",
  failed: "Failed",
  stale: "State changed",
  cancelled: "Cancelled",
};
const date = (n: number) => e(new Date(n).toISOString().replace("T", " ").slice(0, 19)) + " UTC";
export function mountOperations(
  app: Express,
  context: {
    store: HostedStore;
    oauth: HostedOAuth;
    writes: HostedWrites | undefined;
    canReview?: (grant: Grant) => boolean;
    page: (title: string, body: string) => string;
    cookie: (req: Request, name: string) => string;
    csrf: (req: Request, value: string) => void;
  },
): void {
  const { store, oauth, writes, page, cookie, csrf } = context;
  const canReview = context.canReview ?? ((grant: Grant) => Boolean(writes?.hasAccess(grant)));
  function session(req: Request) {
    const owner = fingerprint(cookie(req, oauth.manageCookie)),
      browser = store.get<Browser>("browser", owner);
    if (!browser)
      throw new PluginError(
        "connection_expired",
        "Connect from your AI in this browser to see its private operations page.",
      );
    return { owner, browser };
  }
  function ownGrant(req: Request, id: string) {
    const { owner, browser } = session(req),
      grant = store.get<Grant>("grant", id);
    if (!grant || grant.owner !== owner)
      throw new PluginError(
        "access_denied",
        "This connection belongs to another browser or has expired.",
      );
    return { owner, browser, grant };
  }
  function ownPlan(req: Request, id: string) {
    const { owner, browser } = session(req),
      plan = store.get<Plan>("write-plan", id);
    const grant = plan && store.get<Grant>("grant", plan.principal),
      record = plan && store.get<ConnectionRecord>("connection-record", plan.principal);
    if (!plan || (grant?.owner ?? record?.owner) !== owner)
      throw new PluginError("access_denied", "This operation is unavailable in this browser.");
    return { owner, browser, plan, grant };
  }
  app.get("/operations", (req, res) => {
    const { owner } = session(req);
    const grants = store.list<Grant>("grant").filter((r) => r.value.owner === owner),
      records = store
        .list<ConnectionRecord>("connection-record")
        .filter((r) => r.value.owner === owner),
      ids = new Set([...grants, ...records].map((r) => r.id));
    const plans = store
      .list<Plan>("write-plan")
      .map((r) => r.value)
      .filter((p) => ids.has(p.principal))
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, 100);
    res
      .type("html")
      .send(
        page(
          "Operations",
          `<h1>Your operations.</h1><p class="lead">Connections, permissions and changes authorised in this browser.</p><div class="hero-actions"><a class="button" href="/connections">Manage access</a><a class="button secondary" href="/#setup">Connect another AI</a><a class="button secondary" href="/runners">Deployment runners</a></div><section class="section"><h2>Connections</h2>${grants.length ? grants.map(({ id, value: g }) => `<div class="operation-row"><div><strong>${e(store.get<{ client_name?: string }>("client", g.client)?.client_name ?? "AI app")}</strong><small>Account ${g.account} · expires ${date(g.expires)}</small></div><div><span>${e((g.scopes ?? [SCOPE]).map((s) => s.replace("infomaniak:", "")).join(", "))}</span><br><a href="/connections/${e(id)}/access">Review permissions</a></div></div>`).join("") : "<p>No active connections.</p>"}</section><section class="section"><h2>Recent changes</h2>${plans.length ? plans.map((p) => `<div class="operation-row"><div><a href="/operations/${e(p.id)}">${e(p.operation)}</a><small>${date(p.updated_at)}</small></div><div>${e(labels[p.state] ?? p.state)}<small>${e(p.change.resource)}</small></div></div>`).join("") : "<p>No changes yet. Ask your AI to inspect a consented resource and prepare a plan. Planning makes no provider change.</p>"}</section>`,
        ),
      );
  });
  app.get("/operations/:id", (req, res) => {
    const { plan: p, grant, browser } = ownPlan(req, String(req.params.id));
    res
      .type("html")
      .send(
        page(
          "Operation details",
          `<a href="/operations">← Operations</a><h1>${e(labels[p.state] ?? p.state)}</h1><p class="lead">${e(p.operation)} · ${e(p.change.resource)}</p><p>${e(p.outcome ?? "No provider request has been sent.")}</p><small>Updated ${date(p.updated_at)} · plan ${e(p.id)}</small><section class="section"><h2>Proposed change</h2><code>${e(JSON.stringify({ before: p.change.before, after: p.change.after }, null, 2))}</code><p>${e(p.change.impact)}</p><h2>Recovery</h2><p>${e(p.change.recovery)}</p>${grant && canReview(grant) && p.state === "planned" ? `<a class="button" href="/write-reviews/${e(p.id)}">Review this change</a>` : ""}${grant && writes?.hasAccess(grant) && p.state === "verified" && ((p.operation.startsWith("dns.record.") && grant.scopes?.includes(DNS_SCOPE) && grant.resources?.zones.includes(String(p.args.zone))) || p.operation.startsWith("mail.alias.")) ? `<form method="post" action="/operations/${e(p.id)}/recover"><input type="hidden" name="csrf" value="${e(browser.csrf)}"><button>Prepare a recovery plan</button><small>Creates a new plan from current state. It needs its own approval.</small></form>` : ""}${["unknown", "pending"].includes(p.state) ? '<p class="notice">Ask your AI to reconcile this operation. Readback checks the result without sending the mutation again.</p>' : ""}</section>`,
        ),
      );
  });
  app.get("/connections/:id/access", (req, res) => {
    const id = String(req.params.id),
      { browser, grant: g } = ownGrant(req, id);
    res
      .type("html")
      .send(
        page(
          "Connection permissions",
          `<a href="/operations">← Operations</a><h1>Connection access.</h1><p class="lead">Account ${g.account}. Remove access here; connect again from your AI to add resources.</p><form method="post"><input type="hidden" name="csrf" value="${e(browser.csrf)}"><fieldset class="write-consent"><legend>Domains</legend>${(g.resources?.zones ?? []).map((z) => `<label><input type="checkbox" name="zones" value="${e(z)}" checked>${e(z)}</label>`).join("") || "<p>No full-domain DNS access.</p>"}</fieldset><fieldset class="write-consent"><legend>Mailboxes</legend>${(g.resources?.mailboxes ?? []).map((m) => `<label><input type="checkbox" name="mailboxes" value="${m.hosting}:${e(m.name)}" checked>${e(m.address)}</label>`).join("") || "<p>No mailbox administration access.</p>"}</fieldset><fieldset class="write-consent"><legend>Deployment</legend>${(g.resources?.deployments ?? []).map((d) => `<label><input type="checkbox" name="deployments" value="${e(d.runner + ":" + d.app)}" checked>${e(d.app)} · ${e(d.runner)}</label>`).join("") || "<p>No paired apps.</p>"}${g.resources?.deploymentEnrollment ? '<label><input type="checkbox" name="enrollment" value="yes" checked>Allow pairing new runners with a separate review</label>' : ""}</fieldset>${g.writeZone ? `<fieldset class="write-consent"><legend>Legacy test access</legend><label><input type="checkbox" name="legacy" value="yes" checked>Test TXT in ${e(g.writeZone)}</label></fieldset>` : ""}<button>Save allowed resources</button><small>Existing AI credentials immediately lose removed permissions. A provider request already in progress may finish.</small></form>`,
        ),
      );
  });
  app.post("/connections/:id/access", (req, res) => {
    const id = String(req.params.id),
      { browser, grant: g } = ownGrant(req, id);
    csrf(req, browser.csrf);
    const strings = (v: unknown): string[] =>
      v === undefined
        ? []
        : z
            .array(z.string().max(300))
            .max(20)
            .parse(Array.isArray(v) ? v : [v]);
    const zones = strings(req.body.zones),
      mailboxes = strings(req.body.mailboxes),
      deployments = strings(req.body.deployments);
    store.atomic(() => {
      const current = store.get<Grant>("grant", id);
      if (!current || current.owner !== g.owner || current.account !== g.account)
        throw new PluginError("access_denied", "This connection was disconnected.");
      if (
        zones.some((z) => !current.resources?.zones.includes(z)) ||
        mailboxes.some(
          (key) => !current.resources?.mailboxes.some((m) => m.hosting + ":" + m.name === key),
        ) ||
        deployments.some(
          (key) => !current.resources?.deployments?.some((d) => d.runner + ":" + d.app === key),
        ) ||
        (req.body.enrollment === "yes" && !current.resources?.deploymentEnrollment)
      )
        throw new PluginError("access_denied", "This page can only remove existing grants.");
      if (current.resources) {
        current.resources.zones = zones;
        current.resources.mailboxes = current.resources.mailboxes.filter((m) =>
          mailboxes.includes(m.hosting + ":" + m.name),
        );
        current.resources.deployments = (current.resources.deployments ?? []).filter((d) =>
          deployments.includes(d.runner + ":" + d.app),
        );
        current.resources.deploymentEnrollment =
          req.body.enrollment === "yes" && Boolean(current.resources.deploymentEnrollment);
      }
      if (req.body.legacy !== "yes") delete current.writeZone;
      current.scopes = [
        SCOPE,
        ...(current.writeZone ? [WRITE_SCOPE] : []),
        ...(zones.length ? [DNS_SCOPE] : []),
        ...(mailboxes.length ? [MAIL_SCOPE] : []),
        ...(current.resources?.deployments?.length || current.resources?.deploymentEnrollment
          ? [DEPLOY_SCOPE]
          : []),
      ];
      store.put("grant", id, current, current.expires);
    });
    res.redirect(303, "/connections/" + id + "/access");
  });
  app.post("/operations/:id/recover", async (req, res) => {
    const { plan, grant, browser } = ownPlan(req, String(req.params.id));
    csrf(req, browser.csrf);
    if (!grant || !writes || plan.state !== "verified")
      throw new PluginError(
        "invalid_state",
        "Only a verified operation with active resource access can prepare recovery.",
      );
    const recovery = await writes.recovery(plan.principal, grant, plan);
    res.redirect(303, "/write-reviews/" + recovery.id);
  });
}
