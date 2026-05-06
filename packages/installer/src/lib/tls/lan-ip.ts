import { networkInterfaces } from "node:os";

function isRfc1918(ip: string): boolean {
  return (
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
  );
}

/**
 * Pick the host's primary LAN IP for inclusion in the self-CA leaf cert SAN.
 * Preference order:
 *   1. First RFC1918 IPv4 found across interfaces — almost always the right
 *      answer for a homelab/internal box (the user reaches this host from
 *      its 192.168.x.y / 10.x.y.z address).
 *   2. First non-loopback IPv4 — for hosts on a public IP.
 *   3. 127.0.0.1 — degenerate fallback (loopback-only). At least the leaf
 *      will still match localhost access.
 */
export function detectLanIp(): string {
  const ifaces = networkInterfaces();
  const candidates: string[] = [];
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const info of list) {
      if (info.family === "IPv4" && !info.internal) {
        candidates.push(info.address);
      }
    }
  }
  const rfc1918 = candidates.find(isRfc1918);
  if (rfc1918) return rfc1918;
  if (candidates.length > 0) return candidates[0]!;
  return "127.0.0.1";
}
