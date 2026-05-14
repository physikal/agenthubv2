/**
 * Resolve the public-facing host (without scheme/port/path) that operators
 * use to reach this AgentHub install. Used by local-docker deploys to
 * tell agents the shareable URL of the just-deployed app.
 *
 * Precedence: explicit AGENTHUB_PUBLIC_HOST, then derive from
 * AGENTHUB_PUBLIC_URL's hostname. Fall through to the caller's fallback
 * when neither is set (e.g., a dev box with no public URL).
 */
export function resolveAgenthubHost(fallback = "127.0.0.1"): string {
  const explicit = process.env["AGENTHUB_PUBLIC_HOST"];
  if (explicit) return explicit;
  const url = process.env["AGENTHUB_PUBLIC_URL"];
  if (url) {
    try {
      return new URL(url).hostname || fallback;
    } catch {
      // Malformed URL — fall through.
    }
  }
  return fallback;
}
