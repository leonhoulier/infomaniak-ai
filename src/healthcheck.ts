import { loadAccess } from "./access.js";
import { request } from "node:http";
try {
  const config = await loadAccess(
    process.env.INFOMANIAK_POLICY_FILE ?? "/run/secrets/access.local.json",
  );
  if (!config.remote) throw new Error("No listener");
  const remote = config.remote;
  await new Promise<void>((resolve, reject) => {
    const req = request(
      "http://" + (remote.host === "::1" ? "[::1]" : "127.0.0.1") + ":" + remote.port + "/healthz",
      {
        headers: { host: new URL(remote.public_origin).host },
        signal: AbortSignal.timeout(3000),
      },
      (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else reject(new Error("Unhealthy"));
      },
    );
    req.once("error", reject);
    req.end();
  });
} catch {
  process.exitCode = 1;
}
