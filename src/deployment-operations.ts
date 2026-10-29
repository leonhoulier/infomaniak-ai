import { z } from "zod";
import { AppName, Revision } from "./runner-contract.js";
import { object } from "./provider.js";
import { PluginError } from "./errors.js";
import type { Args, Operation } from "./registry.js";

const fields = {
  account_id: z.number().int().positive().safe(),
  runner_id: z.string().uuid(),
  app: AppName,
};
const path = (a: Args) => "/runner/" + a.runner_id + "/apps/" + a.app;
export const DEPLOYMENT_OPERATIONS = new Map<string, Operation>();
for (const action of ["deploy", "rollback"] as const) {
  const id = action === "deploy" ? "deployment.release" : "deployment.rollback";
  DEPLOYMENT_OPERATIONS.set(id, {
    id,
    revision: "1",
    product: "Customer-owned VPS runner",
    summary:
      action === "deploy"
        ? "Deploy one pinned repository commit to a paired app."
        : "Restore the paired app's retained previous release.",
    write: true,
    method: "POST",
    path: "/runner/{runner_id}/apps/{app}",
    input: z.object({ ...fields, ...(action === "deploy" ? { revision: Revision } : {}) }).strict(),
    resource: (a) => ({ kind: "vps", key: a.runner_id + ":" + a.app }),
    inspect: async (api, a, planId) =>
      api.request("GET", path(a), undefined, undefined, planId ? { planId } : undefined),
    change: (a, before) => {
      const state = object(before),
        revision = action === "deploy" ? a.revision : state.previous_revision;
      if (typeof revision !== "string")
        throw new PluginError("resource_not_found", "This app has no retained previous release.");
      if (state.uncertain)
        throw new PluginError(
          "unknown_outcome",
          "The runner must reconcile its interrupted deployment first.",
        );
      return {
        before,
        after: { revision, healthy: true },
        request: { method: "POST", path: path(a), body: { action, revision } },
        resource: "runner:" + a.runner_id + ":" + a.app,
        impact:
          "Build and release the pinned repository commit on the customer-owned runner, switch its app route and verify health. Repository build code runs on that VPS.",
        recovery:
          "Use deployment.rollback to prepare a separate plan for the retained previous image. This release path supports stateless HTTP apps; database migrations and external data are not rolled back.",
      };
    },
    matches: (actual, expected) =>
      object(actual).revision === object(expected).revision &&
      object(actual).job_verified === true &&
      object(actual).healthy === true &&
      object(actual).uncertain !== true,
  });
}
DEPLOYMENT_OPERATIONS.set("deployment.app.get", {
  id: "deployment.app.get",
  revision: "1",
  product: "Customer-owned VPS runner",
  summary: "Inspect the paired app's latest signed runner report and health.",
  write: false,
  method: "GET",
  path: "/runner/{runner_id}/apps/{app}",
  input: z.object(fields).strict(),
  resource: (a) => ({ kind: "vps", key: a.runner_id + ":" + a.app }),
  read: async (api, a) => api.request("GET", path(a)),
});
