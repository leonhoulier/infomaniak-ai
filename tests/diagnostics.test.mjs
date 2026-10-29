import assert from "node:assert/strict";
import { test } from "node:test";
import { auditRecords, lookup } from "../dist/registry.js";
import { fixture } from "./fixtures/api.mjs";

const zone = { account_id: 10, zone: "example.com" };
const codes = (findings) => findings.map((f) => f.code).sort();
const rec = (type, source, target, ttl = 3600) => ({ type, source, target, ttl });

test("CAA propagation compares DNS presentation values with Node's structured answers", async (t) => {
  const f = await fixture(t);
  f.api.records = [
    { id: 1, ...rec("CAA", ".", "0   ISSUE letsencrypt.org") },
    { id: 2, ...rec("CAA", ".", '128 issuewild ";"') },
    { id: 3, ...rec("CAA", ".", '0 iodef "mailto:pki@example.com"') },
  ];
  t.mock.method(lookup, "query", async () => [
    { critical: 0, iodef: "mailto:pki@example.com" },
    { critical: 128, issuewild: ";" },
    { critical: 0, issue: "letsencrypt.org" },
  ]);
  const result = await f.engine.read("dns.propagation", { ...zone, type: "CAA" });
  assert.equal(result.data.resolvers_agree, true);
  assert.equal(result.data.matches_zone, true);
  assert(result.data.zone_values.includes('0 issue "letsencrypt.org"'));
});

test("audit: a typical Infomaniak mail zone with delegated DKIM is clean apart from info", () => {
  const findings = auditRecords([
    rec("MX", ".", "5 mta-gw.infomaniak.ch."),
    rec("TXT", ".", '"v=spf1 include:spf.infomaniak.ch -all"'),
    rec("TXT", "_dmarc", '"v=DMARC1; p=quarantine"'),
    rec("NS", "_domainkey", "ns41.infomaniak.ch."),
  ]);
  assert.deepEqual(codes(findings), ["dkim_delegated"]);
});

test("audit: flags missing, duplicate and unsafe mail-authentication records", () => {
  assert.deepEqual(codes(auditRecords([rec("A", ".", "192.0.2.1")])), [
    "dmarc_missing",
    "mx_missing",
    "spf_missing",
  ]);
  const findings = auditRecords([
    rec("MX", ".", "5 mta-gw.infomaniak.ch"),
    rec("TXT", ".", "v=spf1 +all"),
    rec("TXT", ".", "v=spf1 -all"),
    rec("TXT", "_dmarc", "v=DMARC1; p=none"),
    rec("CNAME", ".", "other.example.net", 60),
  ]);
  assert.deepEqual(codes(findings), [
    "apex_cname",
    "dkim_not_found",
    "dmarc_monitor_only",
    "low_ttl",
    "spf_allows_all",
    "spf_missing_infomaniak",
    "spf_missing_infomaniak",
    "spf_multiple",
  ]);
});

test("dns.audit reads only the granted zone and returns findings", async (t) => {
  const f = await fixture(t);
  f.api.records = [{ id: 1, source: "", type: "A", target: "192.0.2.1", ttl: 3600 }];
  const result = await f.engine.read("dns.audit", zone);
  assert.equal(result.data.zone, "example.com");
  assert(result.data.findings.some((x) => x.code === "spf_missing"));
  await assert.rejects(f.engine.read("dns.audit", { ...zone, zone: "other.example" }));
  assert(f.api.calls.every((c) => c.method === "GET"));
});

test("domains.expiry reports UTC dates, days left and status, soonest first", async (t) => {
  const f = await fixture(t);
  const now = Math.floor(Date.now() / 1000);
  f.api.domains = [
    { id: 1, customer_name: "later.example", expired_at: now + 200 * 86400 + 60 },
    { id: 2, customer_name: "soon.example", expired_at: now + 10 * 86400 + 60 },
    { id: 3, customer_name: "gone.example", expired_at: now - 2 * 86400 },
    { id: 4, customer_name: "unknown.example" },
    { id: 5, customer_name: "hours.example", expired_at: now - 12 * 3600 },
  ];
  const { data } = await f.engine.read("domains.expiry", { account_id: 10 });
  assert.deepEqual(
    data.map((d) => [d.domain, d.status, d.days_left]),
    [
      ["gone.example", "expired", -2],
      ["hours.example", "expired", 0],
      ["soon.example", "expiring", 10],
      ["later.example", "ok", 200],
      ["unknown.example", "unknown", null],
    ],
  );
  assert.match(data[0].expires_at_utc, /Z$/);
  assert(f.api.calls.some((c) => c.path.includes("service_name=domain&per_page=1000")));
});

test("dns.propagation compares resolvers with the zone and never trusts failures", async (t) => {
  const f = await fixture(t);
  f.api.records = [
    { id: 1, source: "www", type: "A", target: "192.0.2.1", ttl: 300 },
    { id: 2, source: ".", type: "MX", target: "5 MTA-GW.infomaniak.ch.", ttl: 300 },
  ];
  const original = lookup.query;
  t.after(() => {
    lookup.query = original;
  });
  const asked = [];
  lookup.query = async (server, name, type) => {
    asked.push([server, name, type]);
    return type === "MX" ? [{ priority: 5, exchange: "mta-gw.infomaniak.ch" }] : ["192.0.2.1"];
  };
  let r = (await f.engine.read("dns.propagation", { ...zone, source: "www" })).data;
  assert.equal(r.name, "www.example.com");
  assert.equal(r.resolvers_agree, true);
  assert.equal(r.matches_zone, true);
  assert.deepEqual(asked.map((a) => a[0]).sort(), ["1.1.1.1", "8.8.8.8", "9.9.9.9"]);
  r = (await f.engine.read("dns.propagation", { ...zone, type: "MX" })).data;
  assert.equal(r.name, "example.com");
  assert.deepEqual(r.zone_values, ["5 mta-gw.infomaniak.ch"]);
  assert.equal(r.matches_zone, true);
  lookup.query = async (server) => {
    if (server === "9.9.9.9") throw Object.assign(new Error("x"), { code: "ETIMEOUT" });
    return ["192.0.2.1"];
  };
  r = (await f.engine.read("dns.propagation", { ...zone, source: "www" })).data;
  assert.equal(r.resolvers_agree, false);
  assert.equal(r.matches_zone, null);
  assert.equal(r.resolvers.find((x) => x.resolver === "quad9").error, "ETIMEOUT");
  lookup.query = async () => ["192.0.2.99"];
  r = (await f.engine.read("dns.propagation", { ...zone, source: "www" })).data;
  assert.equal(r.resolvers_agree, true);
  assert.equal(r.matches_zone, false);
  await assert.rejects(
    f.engine.read("dns.propagation", { ...zone, zone: "other.example", source: "www" }),
  );
});
