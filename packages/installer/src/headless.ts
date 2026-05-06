import { execFileSync } from "node:child_process";
import {
  applyEnvOverrides,
  emptyConfig,
  missingRequiredForHeadless,
} from "./lib/config.js";
import { runInstall } from "./run.js";
import { randomPassword } from "./lib/secrets.js";
import { resolveTlsMode, type ResolvedTlsMode } from "./lib/tls/resolve-mode.js";
import { probeServingCert } from "./lib/tls/probe-cert.js";
import { preflightDns01 } from "./lib/tls/preflight.js";

/**
 * Non-interactive install. Reads every answer from env vars (AGENTHUB_MODE,
 * AGENTHUB_DOMAIN, …) so that coding agents (Claude Code, OpenClaw, Hermes)
 * can drive the installer without a TTY.
 *
 * Exit codes:
 *   0  success
 *   2  missing required env var
 *   3  install failure
 */

/**
 * Front-door probe. Two-stage:
 *   1. Reachability — `curl --resolve` against Traefik's :443 (sidesteps DNS).
 *      ACME modes get up to 90s because DNS-01 propagation + cert issuance
 *      can take 60s+; self-ca is instant; localhost is short.
 *   2. Cert validity — read the serving cert via `openssl s_client` and fail
 *      loudly if Traefik is serving its built-in `TRAEFIK DEFAULT CERT` (the
 *      silent-fallback bug this whole effort exists to kill).
 */
async function probeFrontDoor(
  domain: string,
  resolvedMode: ResolvedTlsMode,
): Promise<void> {
  const url = `https://${domain}/api/health`;
  const args = [
    "-ksf",
    "-m", "5",
    "--resolve", `${domain}:443:127.0.0.1`,
    url,
  ];
  let lastErr = "timeout";
  const reachableMs = resolvedMode === "self-ca" ? 15_000
    : resolvedMode === "none" ? 30_000
    : 90_000;
  const deadline = Date.now() + reachableMs;
  let reachable = false;
  while (Date.now() < deadline) {
    try {
      execFileSync("curl", args, { stdio: "pipe" });
      reachable = true;
      lastErr = "";
      break;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : "curl failed";
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  if (!reachable) {
    throw new Error(
      `Install completed but ${url} is unreachable through the front-door proxy. ` +
        `Check 'docker logs agenthub-traefik-1' and 'docker logs agenthub-agenthub-server-1'. ` +
        `Last curl error: ${lastErr}`,
    );
  }

  // Localhost installs intentionally use Traefik's default cert — skip the
  // cert-validity gate. Every other mode must serve a real cert.
  if (resolvedMode === "none") return;

  let cert;
  try {
    cert = probeServingCert("127.0.0.1", 443, domain);
  } catch (err) {
    throw new Error(
      `Install completed and ${url} is reachable, but cert probe failed: ${
        err instanceof Error ? err.message : "unknown"
      }. Check 'docker logs agenthub-traefik-1 | grep -iE "acme|tls"' for hints.`,
    );
  }
  if (cert.isTraefikDefault) {
    const ackChallenge = resolvedMode === "self-ca"
      ? "Self-CA initialization did not complete."
      : `ACME ${resolvedMode === "public-alpn" ? "TLS-ALPN-01" : "DNS-01"} did not complete.`;
    throw new Error(
      `Install completed but Traefik is serving its default self-signed cert ` +
        `for ${domain}. ${ackChallenge} ` +
        `Check 'docker logs agenthub-traefik-1 | grep -iE "acme|tls"' for the reason. ` +
        explainAcmeFailure(resolvedMode),
    );
  }
}

export function explainAcmeFailure(mode: ResolvedTlsMode | string): string {
  if (mode === "dns-01") {
    return "Common causes: wrong API token, token lacks the right zone, propagation timeout.";
  }
  if (mode === "public-alpn") {
    return "Common causes: port 443 not reachable from the public internet, DNS A record missing or wrong, ISP blocks inbound :443.";
  }
  if (mode === "self-ca") {
    return "Common causes: traefik-self-ca-init container failed — check its logs.";
  }
  return `unexpected mode '${mode}' — please file a bug.`;
}

export async function runHeadless(): Promise<void> {
  const cfg = applyEnvOverrides(emptyConfig());
  if (!cfg.adminPassword) cfg.adminPassword = randomPassword(20);

  const missing = missingRequiredForHeadless(cfg);
  if (missing.length > 0) {
    console.error("Missing required env vars for --non-interactive install:");
    for (const name of missing) console.error(`  ${name}`);
    process.exit(2);
  }

  // DNS-01 pre-flight (Cloudflare token check). Catches the most common
  // failure mode at the env-var layer instead of the 90s ACME-timeout layer.
  // Skippable via AGENTHUB_SKIP_PREFLIGHT=1 for users who know better than
  // the check (e.g. testing offline or a non-Cloudflare provider).
  const resolvedMode = resolveTlsMode(cfg.tlsMode, cfg.domain, process.env);
  if (resolvedMode === "dns-01" && !process.env["AGENTHUB_SKIP_PREFLIGHT"]) {
    console.log("running DNS-01 pre-flight…");
    const pf = await preflightDns01(cfg.tlsDnsProvider, cfg.domain, cfg.tlsDnsEnvVars);
    if (!pf.ok) {
      console.error(`DNS-01 pre-flight failed: ${pf.reason}`);
      console.error("Fix the above and re-run, or set AGENTHUB_SKIP_PREFLIGHT=1 to bypass.");
      process.exit(2);
    }
    if (pf.skipped) {
      console.log(`pre-flight skipped (no built-in check for provider '${cfg.tlsDnsProvider}')`);
    } else {
      console.log("pre-flight ok");
    }
  }

  try {
    const art = await runInstall(cfg, (line) => console.log(line));
    console.log("verifying front-door routing via Traefik…");
    await probeFrontDoor(cfg.domain, resolvedMode);
    console.log("");
    console.log(`AgentHub is up at ${art.url}`);
    console.log(`  Admin user:     admin`);
    console.log(`  Admin password: ${art.adminPassword}`);
    console.log("");
    console.log(`Infisical console: https://secrets.${cfg.domain}/`);
    console.log(`  Admin email:    ${art.infisicalAdminEmail}`);
    console.log(`  Admin password: ${art.infisicalAdminPassword}`);
    console.log("");
    console.log("Save these credentials — they are also written to .env.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Install failed: ${msg}`);
    process.exit(3);
  }
}
