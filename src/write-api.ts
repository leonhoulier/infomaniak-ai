import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Application } from "./application.js";
import type { Principal } from "./access.js";
import { PluginError } from "./errors.js";
import { documentation, DOCUMENTATION_STATUS } from "./documentation.js";

/** JSON facade over the same reviewed policy engine as MCP. No approval endpoint. */
export async function handleWriteApi(
  req: IncomingMessage,
  res: ServerResponse,
  app: Pick<Application, "dispatch">,
  principal: Principal,
  path: string,
  readBody: () => Promise<string>,
  approvalBase = "/approvals",
  docs = documentation,
): Promise<void> {
  const json = (status: number, data: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  };
  try {
    let tool: string,
      args: unknown = {},
      status = 200;
    const plan = /^\/api\/v1\/plans\/([a-f0-9-]{36})(?:\/(execute|reconcile|cancel))?$/.exec(path);
    const expected = path === "/api/v1/capabilities" || (plan && !plan[2]) ? "GET" : "POST";
    if (
      ![
        "/api/v1/capabilities",
        "/api/v1/reads",
        "/api/v1/plans",
        "/api/v1/docs/search",
        "/api/v1/docs/read",
      ].includes(path) &&
      !plan
    ) {
      json(404, { error: "not_found" });
      return;
    }
    if (req.method !== expected) {
      res.setHeader("allow", expected);
      json(405, { error: "method_not_allowed" });
      return;
    }
    let input: unknown = {};
    if (expected === "POST") {
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
        json(415, { error: "json_required" });
        return;
      }
      if (req.headers["content-encoding"]) {
        json(415, { error: "compressed_input_refused" });
        return;
      }
      try {
        input = JSON.parse(await readBody());
      } catch (error) {
        if (error instanceof PluginError) throw error;
        throw new PluginError("invalid_input", "Invalid JSON.");
      }
    }
    if (path === "/api/v1/docs/search" || path === "/api/v1/docs/read") {
      tool = path.endsWith("/search") ? "infomaniak_docs_search" : "infomaniak_docs_read";
      args = input;
    } else if (path === "/api/v1/capabilities") tool = "infomaniak_status";
    else if (path === "/api/v1/reads") {
      tool = "infomaniak_read";
      args = input;
    } else if (path === "/api/v1/plans") {
      tool = "infomaniak_plan";
      args = input;
      status = 201;
    } else {
      const id = z.string().uuid().parse(plan![1]);
      if (plan![2] === "execute") {
        const body = z
          .object({ plan_hash: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict()
          .parse(input);
        tool = "infomaniak_execute";
        args = { plan_id: id, ...body };
      } else {
        if (expected === "POST") z.object({}).strict().parse(input);
        tool = plan![2] === "cancel" ? "infomaniak_cancel" : "infomaniak_operation";
        args = { plan_id: id, ...(plan![2] === "reconcile" ? { refresh: true } : {}) };
      }
    }
    const result = (await docs.dispatch(tool, args)) ?? (await app.dispatch(principal, tool, args));
    if (tool === "infomaniak_status") result.documentation = DOCUMENTATION_STATUS;
    json(status, {
      ...result,
      ...(tool === "infomaniak_plan"
        ? { approval_url: approvalBase + "/" + (result.plan as { id: string }).id }
        : {}),
    });
  } catch (error) {
    const code =
      error instanceof PluginError && /^[a-z_]{1,60}$/.test(error.code)
        ? error.code
        : "invalid_input";
    const status =
      code === "documentation_unavailable"
        ? 503
        : code === "documentation_format_changed" || code === "documentation_redirect"
          ? 502
          : code === "documentation_changed"
            ? 409
            : code === "plan_not_found"
              ? 404
              : code === "plan_expired"
                ? 410
                : code === "request_too_large"
                  ? 413
                  : ["access_denied", "writes_disabled", "operation_denied"].includes(code)
                    ? 403
                    : [
                          "approval_required",
                          "plan_mismatch",
                          "invalid_state",
                          "resource_busy",
                        ].includes(code)
                      ? 409
                      : 400;
    // Never echo parser issues, provider descriptions, request values or secrets.
    json(status, {
      error: code,
      message:
        error instanceof PluginError &&
        (code.startsWith("documentation_") || code === "invalid_documentation_url")
          ? error.message
          : code === "approval_required"
            ? "Review this exact plan through the independent human approval page first."
            : "Request rejected. Check the operation, resource grants and current plan state.",
    });
  }
}
