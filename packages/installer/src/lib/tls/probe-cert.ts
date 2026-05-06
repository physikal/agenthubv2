import { execSync } from "node:child_process";

export interface ParsedCert {
  subjectCN: string;
  issuerCN: string;
  issuerO?: string;
  notBefore: Date;
  notAfter: Date;
  isTraefikDefault: boolean;
}

/**
 * Pull a single CN= or O= value from a comma-separated DN string. Tolerates
 * the two forms openssl emits: `CN=foo` and `C=US, O=org, CN=foo`.
 */
function pickField(dn: string, key: string): string | undefined {
  const match = dn.match(new RegExp(`(?:^|,\\s*)${key}=([^,]+)`));
  return match ? match[1]!.trim() : undefined;
}

export function parseOpensslOutput(stdout: string): ParsedCert {
  const subject = stdout.match(/^subject=(.+)$/m)?.[1];
  const issuer = stdout.match(/^issuer=(.+)$/m)?.[1];
  const notBeforeStr = stdout.match(/^notBefore=(.+)$/m)?.[1];
  const notAfterStr = stdout.match(/^notAfter=(.+)$/m)?.[1];
  if (!subject) throw new Error("probe-cert: no subject in openssl output");
  if (!issuer) throw new Error("probe-cert: no issuer in openssl output");
  if (!notBeforeStr || !notAfterStr) {
    throw new Error("probe-cert: missing notBefore/notAfter in openssl output");
  }
  const subjectCN = pickField(subject, "CN") ?? "";
  const issuerCN = pickField(issuer, "CN") ?? "";
  const issuerO = pickField(issuer, "O");
  return {
    subjectCN,
    issuerCN,
    ...(issuerO !== undefined ? { issuerO } : {}),
    notBefore: new Date(notBeforeStr),
    notAfter: new Date(notAfterStr),
    isTraefikDefault: issuerCN === "TRAEFIK DEFAULT CERT",
  };
}

/**
 * Connect to host:port via TLS using SNI=domain, return the parsed serving
 * cert. Throws on connection failure; never returns nullable.
 *
 * Pipes `openssl s_client -showcerts` through `openssl x509 -noout -subject
 * -issuer -dates` so the output is the canonical `subject=…\nissuer=…\n
 * notBefore=…\nnotAfter=…` form that parseOpensslOutput expects. Calling
 * `s_client` directly would emit `NotBefore: …; NotAfter: …` (capital N,
 * single line) instead — which the regex never matched, so every probe
 * threw "missing notBefore/notAfter".
 */
export function probeServingCert(
  host: string,
  port: number,
  sni: string,
): ParsedCert {
  // execSync is the simplest path to a piped command; the inputs are
  // local-IP / port / domain, not user-supplied free text — but we still
  // shell-escape with single quotes to be defensive.
  const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
  const cmd =
    `openssl s_client -connect ${sq(`${host}:${port}`)} ` +
    `-servername ${sq(sni)} -showcerts < /dev/null 2>/dev/null | ` +
    `openssl x509 -noout -subject -issuer -dates`;
  const stdout = execSync(cmd, { timeout: 10_000 }).toString();
  return parseOpensslOutput(stdout);
}
