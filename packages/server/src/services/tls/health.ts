import { execSync } from "node:child_process";

export interface ParsedTlsCert {
  subjectCN: string;
  issuerCN: string;
  issuerO?: string;
  notBefore: Date;
  notAfter: Date;
}

export interface TlsHealth {
  ok: boolean;
  domain: string;
  resolver:
    | "public-alpn"
    | "dns-01"
    | "self-ca"
    | "default-fallback"
    | "unknown";
  issuer: string;
  notBefore: string;
  notAfter: string;
  daysToExpiry: number;
  warnings: string[];
}

export function classifyCert(
  cert: ParsedTlsCert,
  domain: string,
  now: Date,
): TlsHealth {
  const warnings: string[] = [];
  const msPerDay = 86_400_000;
  const daysToExpiry = Math.floor(
    (cert.notAfter.getTime() - now.getTime()) / msPerDay,
  );

  let resolver: TlsHealth["resolver"];
  let issuer: string;

  if (cert.issuerCN === "TRAEFIK DEFAULT CERT") {
    resolver = "default-fallback";
    issuer = "Traefik default (self-signed)";
    warnings.push("serving Traefik default cert — TLS misconfigured");
  } else if (cert.issuerO === "Let's Encrypt") {
    // Can't tell ALPN vs DNS-01 from cert alone; the operator's chosen
    // mode in compose tells the truth, but for health-surface purposes
    // "public-alpn" is the default classification for any LE-issued cert.
    resolver = "public-alpn";
    issuer = "Let's Encrypt";
  } else if (cert.issuerCN.startsWith("AgentHub Self-CA")) {
    resolver = "self-ca";
    issuer = cert.issuerCN;
  } else {
    resolver = "unknown";
    issuer = cert.issuerO ?? cert.issuerCN;
  }

  if (daysToExpiry < 0) {
    warnings.push(`cert expired ${-daysToExpiry} days ago`);
  } else if (daysToExpiry < 14) {
    warnings.push(`expires in ${daysToExpiry} days`);
  }

  if (
    resolver !== "default-fallback" &&
    cert.subjectCN !== domain &&
    !cert.subjectCN.startsWith("*.")
  ) {
    warnings.push(`cert subject ${cert.subjectCN} doesn't match ${domain}`);
  }

  const ok = resolver !== "default-fallback" && daysToExpiry >= 0;

  return {
    ok,
    domain,
    resolver,
    issuer,
    notBefore: cert.notBefore.toISOString(),
    notAfter: cert.notAfter.toISOString(),
    daysToExpiry,
    warnings,
  };
}

let cache: { at: number; result: TlsHealth | null } = { at: 0, result: null };

/**
 * Probe the live serving cert via openssl s_client and classify it. Cached
 * for 60s to avoid hammering Traefik on health-check loops.
 */
export function getTlsHealth(domain: string, force = false): TlsHealth {
  if (!force && cache.result && Date.now() - cache.at < 60_000) {
    return cache.result;
  }
  let cert: ParsedTlsCert;
  try {
    cert = probe(domain);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "probe failed";
    const result: TlsHealth = {
      ok: false,
      domain,
      resolver: "unknown",
      issuer: "(probe failed)",
      notBefore: new Date(0).toISOString(),
      notAfter: new Date(0).toISOString(),
      daysToExpiry: 0,
      warnings: [msg],
    };
    cache = { at: Date.now(), result };
    return result;
  }
  const result = classifyCert(cert, domain, new Date());
  cache = { at: Date.now(), result };
  return result;
}

function probe(domain: string): ParsedTlsCert {
  // Pipe s_client through `openssl x509 -noout -subject -issuer -dates`
  // so the output is the canonical `subject=…\nissuer=…\nnotBefore=…\n
  // notAfter=…` form parseOpenssl expects. Without the second openssl
  // invocation, s_client emits `NotBefore: …; NotAfter: …` (capital N,
  // single line) which the regex never matched — so every probe threw
  // "missing required fields".
  const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
  // Probe Traefik via its docker service name, NOT 127.0.0.1: the
  // server container's loopback isn't Traefik. SNI stays as the user's
  // domain so Traefik picks the right router/cert.
  const cmd =
    `openssl s_client -connect traefik:443 -servername ${sq(domain)} ` +
    `-showcerts < /dev/null 2>/dev/null | ` +
    // Extract just the first PEM block — s_client emits a connection-
    // log preamble followed by the cert chain, and x509 chokes on the
    // preamble (alpine inside the server container is strict about
    // input that isn't pure PEM).
    `sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' | ` +
    `openssl x509 -noout -subject -issuer -dates`;
  const stdout = execSync(cmd, { timeout: 8_000 }).toString();
  return parseOpenssl(stdout);
}

function parseOpenssl(stdout: string): ParsedTlsCert {
  const subject = stdout.match(/^subject=(.+)$/m)?.[1];
  const issuer = stdout.match(/^issuer=(.+)$/m)?.[1];
  const nb = stdout.match(/^notBefore=(.+)$/m)?.[1];
  const na = stdout.match(/^notAfter=(.+)$/m)?.[1];
  if (!subject || !issuer || !nb || !na) {
    throw new Error("probe: missing required fields in openssl output");
  }
  // openssl emits `CN = value` (with spaces) on RFC 2253 DN strings;
  // some platforms / older releases emit `CN=value`. Tolerate both.
  const pickField = (dn: string, key: string): string | undefined =>
    dn.match(new RegExp(`(?:^|,\\s*)${key}\\s*=\\s*([^,]+)`))?.[1]?.trim();
  const issuerO = pickField(issuer, "O");
  return {
    subjectCN: pickField(subject, "CN") ?? "",
    issuerCN: pickField(issuer, "CN") ?? "",
    ...(issuerO !== undefined ? { issuerO } : {}),
    notBefore: new Date(nb),
    notAfter: new Date(na),
  };
}
