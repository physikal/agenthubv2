/**
 * LXC containers (pool + hosting) live in a single DHCP range on the
 * physhlab network. The server accepts agent registrations and proxies
 * terminal/preview traffic to these IPs; registering an IP outside this
 * range would let a rogue container redirect traffic anywhere on the LAN.
 *
 * Keep this subnet in sync with the Proxmox DHCP reservation and any
 * future subnet expansion.
 */
const LXC_CIDR = "192.168.4.0/23";

/** Parse a CIDR like "192.168.4.0/23" into [network, mask] as uint32. */
function parseCidr(cidr: string): [number, number] {
  const [net, bitsStr] = cidr.split("/");
  if (!net || !bitsStr) throw new Error(`Invalid CIDR: ${cidr}`);
  const bits = parseInt(bitsStr, 10);
  if (bits < 0 || bits > 32) throw new Error(`Invalid CIDR bits: ${cidr}`);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [ipToUint32(net) & mask, mask];
}

/** Convert "A.B.C.D" → uint32. Throws on malformed input. */
function ipToUint32(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) throw new Error(`Invalid IPv4: ${ip}`);
  let n = 0;
  for (const part of parts) {
    const octet = parseInt(part, 10);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      throw new Error(`Invalid IPv4 octet in ${ip}`);
    }
    n = (n * 256 + octet) >>> 0;
  }
  return n;
}

const [LXC_NET, LXC_MASK] = parseCidr(LXC_CIDR);

/**
 * True if the given IP is inside the LXC subnet.
 *
 * Fail-closed: malformed IP strings return `false` rather than throwing,
 * so route handlers can uniformly reject with a 400.
 */
export function isInLxcSubnet(ip: string): boolean {
  try {
    const n = ipToUint32(ip);
    return (n & LXC_MASK) === LXC_NET;
  } catch {
    return false;
  }
}
