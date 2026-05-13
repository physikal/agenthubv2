import type { AccessMode, PublicTlsMode } from "./types.js";
import type { TlsMode } from "../config.js";

/**
 * Resolve the access mode for an install. Localhost always collapses to `lan`
 * (Let's Encrypt cannot certify the literal hostname). Otherwise the declared
 * mode is honored verbatim.
 */
export function resolveAccessMode(
  declared: AccessMode,
  domain: string,
  _env: Record<string, string | undefined>,
): AccessMode {
  if (domain === "localhost") return "lan";
  return declared;
}

/**
 * Resolve the TLS sub-mode for `public` access mode. Auto-mode infers from
 * env: presence of a DNS provider var → dns-01, otherwise → public-alpn.
 * Explicit values pass through.
 */
export function resolvePublicTlsMode(
  declaredTls: TlsMode,
  env: Record<string, string | undefined>,
): PublicTlsMode {
  if (declaredTls === "public-alpn") return "public-alpn";
  if (declaredTls === "dns-01") return "dns-01";
  if (env["AGENTHUB_TLS_DNS_PROVIDER"]) return "dns-01";
  return "public-alpn";
}
