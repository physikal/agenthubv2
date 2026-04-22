/**
 * Shared origin / CSRF helper. Used by the HTTP CSRF middleware and by the
 * terminal + preview WebSocket upgrade handlers so a single policy governs
 * every state-changing entry point.
 */

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);

function parseOrigins(): Set<string> {
  const base = new Set<string>([
    "http://localhost:5173",
    "http://localhost:3000",
    `http://localhost:${String(PORT)}`,
  ]);
  const configured = process.env["AGENTHUB_PUBLIC_URL"];
  if (configured) base.add(configured.replace(/\/$/, ""));
  const extra = process.env["AGENTHUB_ALLOWED_ORIGINS"];
  if (extra) {
    for (const o of extra.split(",").map((s) => s.trim()).filter(Boolean)) {
      base.add(o);
    }
  }
  return base;
}

export const ALLOWED_ORIGINS = parseOrigins();

/**
 * A request is "trusted" if either:
 *   1. Its Origin is in the explicit allowlist (dev ports, AGENTHUB_PUBLIC_URL,
 *      AGENTHUB_ALLOWED_ORIGINS) — covers legitimate cross-origin callers.
 *   2. Its Origin is same-origin as the request itself (Origin host equals
 *      the Host header it arrived with). Browsers won't let a cross-site
 *      page spoof the Origin header, so same-origin is by definition not
 *      CSRF. This lets a DOMAIN=localhost install be reached from a LAN IP,
 *      SSH tunnel, or dynamic hostname without the operator having to
 *      enumerate every reachable URL at install time.
 */
export function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (host) {
    try {
      if (new URL(origin).host === host) return true;
    } catch {
      /* malformed Origin → reject */
    }
  }
  return false;
}
