/**
 * Access mode — how the install is reached by users.
 * `tunnel` is reserved for a follow-up PR (Cloudflare Tunnel).
 */
export type AccessMode = "lan" | "public";

/**
 * TLS sub-mode, only meaningful when `accessMode === "public"`.
 */
export type PublicTlsMode = "public-alpn" | "dns-01";

export const VALID_ACCESS_MODES: readonly AccessMode[] = ["lan", "public"] as const;
export const VALID_PUBLIC_TLS_MODES: readonly PublicTlsMode[] = [
  "public-alpn",
  "dns-01",
] as const;
