import { PluginError } from "./errors.js";
export class ApiError extends PluginError {
  constructor(
    public readonly uncertain: boolean,
    public readonly status?: number,
    /** Infomaniak's error code, e.g. "alias_does_not_exist"; never the description text. */
    public readonly upstream?: string,
  ) {
    super(
      uncertain ? "unknown_outcome" : "provider_error",
      (uncertain
        ? "The provider outcome is uncertain. Reconcile this operation before another mutation."
        : "The provider rejected the request. Check access, resource state and documented requirements.") +
        (status ? " HTTP " + status + "." : "") +
        (upstream ? " Infomaniak code: " + upstream + "." : ""),
    );
  }
}
/** Read only the error code from a rejected response; descriptions can echo input. */
async function upstreamCode(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const error = (JSON.parse(text) as { error?: { code?: unknown } }).error;
    return typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(error.code)
      ? error.code
      : undefined;
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}
export interface Api {
  request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
    context?: { planId: string },
  ): Promise<unknown>;
}
/** One process-wide queue: conservative for central-API limits across all tenants. */
export class RequestQueue {
  private tail: Promise<void> = Promise.resolve();
  private last = 0;
  constructor(private readonly interval = 1100) {}
  async run<T>(call: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      const wait = this.interval - (Date.now() - this.last);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.last = Date.now();
      return await call();
    } finally {
      release();
    }
  }
}
export class PublicApi implements Api {
  constructor(
    private readonly token: string,
    private readonly queue: RequestQueue,
    private readonly transport: typeof fetch = fetch,
  ) {}
  async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!/^\/[12]\//.test(path) || path.includes("\\") || /[\r\n#]/.test(path))
      throw new PluginError("transport_denied", "Only fixed public API routes are accepted.");
    const url = new URL(path, "https://api.infomaniak.com");
    if (url.origin !== "https://api.infomaniak.com" || url.username || url.password)
      throw new PluginError("transport_denied", "Unexpected API origin.");
    return this.queue.run(async () => {
      if (signal?.aborted) throw new ApiError(false);
      let response: Response;
      try {
        response = await this.transport(url, {
          method,
          redirect: "error",
          credentials: "omit",
          headers: {
            authorization: "Bearer " + this.token,
            accept: "application/json",
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
        });
      } catch {
        throw new ApiError(method !== "GET");
      }
      if (!response.ok)
        throw new ApiError(
          method !== "GET" && (response.status >= 500 || response.status === 408),
          response.status,
          await upstreamCode(response),
        );
      if (response.status === 204) return null;
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 1_000_000) {
              await reader.cancel();
              throw new Error("Response budget");
            }
            chunks.push(value);
          }
        } catch {
          throw new ApiError(method !== "GET");
        }
      }
      let data: unknown;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new ApiError(method !== "GET");
      }
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const object = data as Record<string, unknown>;
        if (object.result === "error" || object.status === "error" || object.success === false)
          throw new ApiError(method !== "GET");
        if (object.result === "success" || Object.hasOwn(object, "data")) {
          if (
            object.has_more === true ||
            // Infomaniak's own pagination envelope: { page, pages, items_per_page, total }.
            (typeof object.pages === "number" && Number(object.page ?? 1) < object.pages) ||
            (object.pagination &&
              typeof object.pagination === "object" &&
              Number((object.pagination as Record<string, unknown>).last_page) >
                Number((object.pagination as Record<string, unknown>).current_page ?? 1))
          )
            throw new PluginError(
              "incomplete_response",
              "Paginated response is incomplete. Narrow the request or implement this endpoint's pagination before planning a mutation.",
            );
          return object.data ?? null;
        }
      }
      return data;
    });
  }
}
export function list(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new PluginError("invalid_response", "Expected a complete provider list.");
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PluginError("invalid_response", "Unexpected provider object.");
  return value as Record<string, unknown>;
}
