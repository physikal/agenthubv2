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
 * Resolve the TLS sub-mode for `public` access mode. Passes through valid
 * PublicTlsMode values. Falls back to `public-alpn` for unrecognised strings
 * (e.g. legacy "auto" read from a pre-migration .env).
 */
export function resolvePublicTlsMode(
  declaredTls: TlsMode,
  _env: Record<string, string | undefined>,
): PublicTlsMode {
  if (declaredTls === "dns-01") return "dns-01";
  return "public-alpn";
}
