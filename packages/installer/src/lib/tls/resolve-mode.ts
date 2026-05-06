import type { TlsMode } from "../config.js";

export type ResolvedTlsMode = "public-alpn" | "dns-01" | "self-ca" | "none";

/**
 * Maps the user's declared mode + domain + env to a concrete TLS strategy.
 *
 * - `none` means "no Traefik override; rely on the default cert" — used for
 *   localhost installs where there is no real domain to certify.
 * - Auto-mode infers the strategy from supplied env vars: presence of a DNS
 *   provider env var → dns-01; otherwise → public-alpn.
 * - Explicit non-auto modes are honored verbatim, except public-alpn on
 *   localhost which collapses to `none` (Let's Encrypt won't certify the
 *   literal hostname `localhost`, so attempting it is pure churn).
 */
export function resolveTlsMode(
  declared: TlsMode,
  domain: string,
  env: Record<string, string | undefined>,
): ResolvedTlsMode {
  if (domain === "localhost") return "none";

  if (declared === "public-alpn") return "public-alpn";
  if (declared === "dns-01") return "dns-01";
  if (declared === "self-ca") return "self-ca";

  if (env["AGENTHUB_TLS_DNS_PROVIDER"]) return "dns-01";
  return "public-alpn";
}
