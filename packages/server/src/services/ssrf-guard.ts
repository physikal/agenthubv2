/**
 * Outbound-fetch guard for user-supplied provider URLs.
 *
 * Several integrations let an authenticated user set a `baseUrl` (the AI
 * providers, Dokploy) that the server then fetches. On a cloud deploy that
 * lets a user point the server at the instance-metadata endpoint
 * (169.254.169.254) to read cloud credentials. We block loopback and
 * link-local targets before connecting.
 *
 * RFC 1918 private ranges (10/8, 172.16/12, 192.168/16) are intentionally
 * NOT blocked: AgentHub is commonly LAN-hosted and a self-hosted Dokploy or
 * AI endpoint legitimately lives on a private address. Blocking those would
 * break the normal LAN install.
 *
 * Limitation: a hostname re-resolved to a blocked address *between* this
 * check and the actual connect (DNS rebinding) is not defended against — out
 * of scope for a LAN-trust tool where authenticated users already share the
 * Docker network with internal services.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class BlockedOutboundHostError extends Error {
  constructor(target: string) {
    super(`Refusing to connect to ${target}: loopback/link-local addresses are blocked`);
    this.name = "BlockedOutboundHostError";
  }
}

function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    // 127.0.0.0/8 loopback, 169.254.0.0/16 link-local (incl. the
    // 169.254.169.254 cloud metadata endpoint).
    return ip.startsWith("127.") || ip.startsWith("169.254.");
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    // ::1 loopback; fe80::/10 link-local (fe80–febf); AWS IPv6 metadata;
    // IPv4-mapped forms of the v4 ranges above.
    if (lower === "::1") return true;
    if (/^fe[89ab]/.test(lower)) return true;
    if (lower === "fd00:ec2::254") return true;
    if (/(^|:)(127\.|169\.254\.)/.test(lower)) return true;
    return false;
  }
  return false;
}

/**
 * Reject a user-supplied URL whose host resolves to a loopback or link-local
 * address. Malformed URLs and unresolvable hostnames are passed through — the
 * subsequent fetch fails on its own and surfaces a normal network error.
 */
export async function assertSafeProviderUrl(rawUrl: string): Promise<void> {
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return;
  }
  const bare = host.replace(/^\[/, "").replace(/\]$/, "");
  if (isIP(bare)) {
    if (isBlockedIp(bare)) throw new BlockedOutboundHostError(bare);
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(bare, { all: true });
  } catch {
    return;
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) throw new BlockedOutboundHostError(`${bare} → ${address}`);
  }
}
