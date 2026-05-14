/**
 * Decide whether the session cookie's `Secure` flag should be set. True only
 * when running in production AND the install is served over HTTPS. The
 * lan-http access mode runs over plain HTTP; setting `Secure` there prevents
 * the browser from sending the cookie back, breaking login.
 */
export function cookieSecureFromPublicUrl(): boolean {
  if (process.env["NODE_ENV"] !== "production") return false;
  const url = process.env["AGENTHUB_PUBLIC_URL"] ?? "";
  return url.startsWith("https://");
}
