import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { authorizeRead, createReadOnlyFetch } from "../dist/policy.js";
import { loadSettings, verifyBackend, backendEnvironment } from "../dist/config.js";
import { boundedResult, redact } from "../dist/errors.js";

test("write and arbitrary execution names cannot enter the read boundary", () => {
  for (const name of [
    "infomaniak_api_call",
    "infomaniak_delete_site",
    "infomaniak_nodejs_app_action",
    "constructor",
    "__proto__",
  ]) {
    assert.throws(() => authorizeRead(name, {}), { code: "operation_denied" });
  }
});

test("all account listings require an explicit safe positive integer", () => {
  for (const account_id of [undefined, 0, -1, "10", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => authorizeRead("infomaniak_list_domains", { account_id }), {
      code: "account_required",
    });
  }
  assert.equal(
    authorizeRead("infomaniak_list_domains", { account_id: 10 }),
    "infomaniak_list_domains",
  );
  assert.throws(
    () =>
      authorizeRead("infomaniak_list_domains", { account_id: 10, confirmation_token: "fixture" }),
    { code: "operation_denied" },
  );
});

test("GETs use the intended origin and reject redirects at the fetch boundary", async () => {
  const calls = [];
  const fetcher = createReadOnlyFetch(async (...args) => {
    calls.push(args);
    return new Response("{}");
  });
  await fetcher("https://api.infomaniak.com/1/products", { method: "GET" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].redirect, "error");
});

test("mutations, foreign origins and Request-object bypasses never reach fetch", async () => {
  let calls = 0;
  const fetcher = createReadOnlyFetch(async () => {
    calls++;
    throw new Error("should not execute");
  });
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
    await assert.rejects(fetcher("https://api.infomaniak.com/1/products", { method }), {
      code: "transport_denied",
    });
  }
  for (const target of [
    "http://api.infomaniak.com/1/products",
    "https://example.com/",
    "https://manager.infomaniak.com/proxy/1/products",
    "https://api.infomaniak.com.example.com/",
    "https://user:password@api.infomaniak.com/1/products",
  ]) {
    await assert.rejects(fetcher(target), { code: "transport_denied" });
  }
  await assert.rejects(
    fetcher(new Request("https://api.infomaniak.com/1/products", { method: "POST", body: "{}" })),
    { code: "transport_denied" },
  );
  await assert.rejects(fetcher("https://api.infomaniak.com/1/products", { body: "{}" }), {
    code: "transport_denied",
  });
  assert.equal(calls, 0);
});

test("redaction covers configured values in keys, messages and common credential fields", () => {
  const credential = "fixture-value/with-space";
  const result = redact(
    {
      [credential]: credential,
      nested: { password: "hidden", authorization: "hidden", token: "hidden" },
      url: "https://example.com/?key=hidden",
      message: `Bearer hidden ${encodeURIComponent(credential)}`,
    },
    [credential],
  );
  const text = JSON.stringify(result);
  assert(!text.includes(credential));
  assert(!text.includes("hidden"));
  assert(!text.includes(encodeURIComponent(credential)));
  assert(text.includes("<redacted>"));
});

test("large and deeply nested results fail explicitly", () => {
  assert.throws(() => boundedResult({ content: "x".repeat(32_001) }, []), {
    code: "response_too_large",
  });
  let data = {};
  for (let depth = 0; depth < 40; depth++) data = { data };
  assert.throws(() => boundedResult(data, []), { code: "invalid_response" });
});

test("configuration errors never echo supplied secret values", () => {
  const secret = "short-secret";
  assert.throws(
    () => loadSettings({ INFOMANIAK_API_TOKEN: secret }),
    (error) => {
      assert.equal(error.code, "configuration_required");
      assert(!error.message.includes(secret));
      return true;
    },
  );
});

test("backend integrity catches a changed file and passes only fixed child controls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "infomaniak plugin test "));
  try {
    const path = join(dir, "server.mjs");
    await writeFile(path, "// fixture");
    const settings = loadSettings({
      INFOMANIAK_API_TOKEN: "fixture-".repeat(5),
      INFOMANIAK_MCP_SERVER_PATH: path,
      INFOMANIAK_MCP_SHA256: createHash("sha256").update("// fixture").digest("hex"),
    });
    assert.equal(await verifyBackend(settings), await realpath(path));
    const env = backendEnvironment(settings);
    assert.deepEqual(Object.keys(env).sort(), [
      "INFOMANIAK_API_TOKEN",
      "INFOMANIAK_AUTH_MODE",
      "INFOMANIAK_READ_ONLY",
      "LOG_LEVEL",
    ]);
    assert.equal(env.INFOMANIAK_AUTH_MODE, "disabled");
    assert.equal(env.INFOMANIAK_READ_ONLY, "1");
    await writeFile(path, "// changed");
    await assert.rejects(verifyBackend(settings), { code: "backend_changed" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
