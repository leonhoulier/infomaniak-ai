/** A stable failure code with a message suitable for an MCP client. */
export class PluginError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PluginError";
  }
}

const SECRET_FIELD =
  /password|secret|token|cookie|authorization|sasession|api[_-]?key|credential|jwt/i;

/** Redact configured credentials and common credential fields before returning data. */
export function redact(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 30)
    throw new PluginError("invalid_response", "Upstream response is nested too deeply.");
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets)
      if (secret) {
        text = text
          .replaceAll(secret, "<redacted>")
          .replaceAll(encodeURIComponent(secret), "<redacted>");
      }
    return text
      .replace(/bearer\s+[^\s"<>]+/gi, "Bearer <redacted>")
      .replace(/([?&](?:token|key|secret|password|access_token)=)[^&\s]+/gi, "$1<redacted>");
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        String(redact(key, secrets, depth + 1)),
        SECRET_FIELD.test(key) ? "<redacted>" : redact(field, secrets, depth + 1),
      ]),
    );
  }
  return value;
}

/** Bound successful responses without silently truncating or corrupting JSON. */
export function boundedResult(
  value: Record<string, unknown>,
  secrets: readonly string[],
): Record<string, unknown> {
  const safe = redact(value, secrets) as Record<string, unknown>;
  if (JSON.stringify(safe).length > 32_000) {
    throw new PluginError(
      "response_too_large",
      "Result exceeds the response budget. Choose a more specific read.",
    );
  }
  return safe;
}
