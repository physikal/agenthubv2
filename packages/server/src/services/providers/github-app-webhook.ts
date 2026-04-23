/**
 * Pure helpers for validating GitHub App webhook deliveries. Extracted so
 * the route file (which imports db + secrets) doesn't have to be imported
 * by unit tests wanting to exercise the signature-verification path.
 *
 * Security model:
 *   - Every delivery carries an X-Hub-Signature-256 header formed as
 *     "sha256=<hex>" where the body is HMAC-SHA256'd with the App's
 *     webhook secret (registered at manifest-conversion time).
 *   - The HMAC must be computed over the raw bytes of the request body
 *     *before* JSON.parse round-trips any whitespace. Buffer equality
 *     uses timingSafeEqual to avoid timing oracles.
 *   - Unrecognized events are treated as success (200) but no-op so a
 *     future webhook expansion doesn't require us to ship a matching
 *     release first.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookVerifyResult {
  ok: boolean;
  reason?: "missing_header" | "malformed_header" | "bad_signature";
}

/**
 * Verify an X-Hub-Signature-256 header against the raw body bytes. Returns
 * `{ok: true}` when valid, otherwise `ok: false` with a coarse reason the
 * route layer can log (never echoes the reason to the client — that'd help
 * attackers probe the endpoint).
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): WebhookVerifyResult {
  if (!signatureHeader) return { ok: false, reason: "missing_header" };
  if (!signatureHeader.startsWith("sha256=")) {
    return { ok: false, reason: "malformed_header" };
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  if (expected.length !== provided.length) {
    return { ok: false, reason: "bad_signature" };
  }
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: "bad_signature" };
}
