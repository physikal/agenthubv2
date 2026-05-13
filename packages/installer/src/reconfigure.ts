import {
  copyFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { findComposeDir, restartService } from "./lib/compose.js";
import { renderTraefikOverride } from "./lib/tls/render-override.js";
import { renderTraefikConfig } from "./lib/tls/render-traefik-config.js";
import { probeServingCert } from "./lib/tls/probe-cert.js";
import { explainAcmeFailure } from "./headless.js";

export interface ReconfigureConfig {
  mode: "public-alpn" | "dns-01" | "self-ca";
  domain: string;
  tlsEmail: string;
  tlsDnsProvider: string;
  tlsDnsEnvVars: Record<string, string>;
  lanIp: string;
}

export interface ReconfigureOptions {
  /** Default false: on cert-validity failure, restore the prior override. */
  noRollback?: boolean;
  /** Self-CA only: force regeneration of the leaf cert. */
  regenCert?: boolean;
}

/**
 * Reconfigure TLS for an existing install. Atomic: snapshots prior override,
 * writes new one, restarts Traefik, validates cert, rolls back on failure.
 */
export async function runReconfigure(
  cfg: ReconfigureConfig,
  onLog: (line: string) => void,
  opts: ReconfigureOptions = {},
): Promise<void> {
  const composeDir = findComposeDir();
  const overridePath = join(composeDir, "traefik.override.yml");
  const prevPath = join(composeDir, "traefik.override.yml.prev");

  // Self-CA + regen-cert: re-run the init container with REGEN=1, then
  // restart Traefik to pick up the new leaf. Doesn't touch the override.
  if (opts.regenCert && cfg.mode === "self-ca") {
    onLog("regenerating self-CA leaf cert (REGEN=1)…");
    execFileSync(
      "docker",
      [
        "compose",
        "-f",
        join(composeDir, "docker-compose.yml"),
        "-f",
        overridePath,
        "run",
        "--rm",
        "-e",
        "REGEN=1",
        "traefik-self-ca-init",
      ],
      { stdio: "inherit" },
    );
    onLog("leaf regenerated; restarting traefik to pick up new cert");
    await restartService(composeDir, "traefik", onLog);
    return;
  }

  if (existsSync(overridePath)) {
    copyFileSync(overridePath, prevPath);
    onLog(`snapshot: ${overridePath} -> ${prevPath}`);
  }

  // Always rewrite compose/traefik.yml — Traefik static config lives
  // there now (per the 2026-05-12 redesign), not in env vars or
  // command flags. Mounted via the base compose's --configfile.
  const traefikYaml = renderTraefikConfig({
    mode: cfg.mode,
    domain: cfg.domain,
    tlsEmail: cfg.tlsEmail,
    dnsProvider: cfg.tlsDnsProvider,
  });
  writeFileSync(join(composeDir, "traefik.yml"), traefikYaml, { mode: 0o644 });
  onLog(`wrote ${join(composeDir, "traefik.yml")} (mode: ${cfg.mode})`);

  // Render env-var values as ${VAR} placeholders so docker compose pulls
  // them from .env at run time (secrets stay in .env, mode 0600).
  const dnsEnvVars: Record<string, string> = {};
  for (const name of Object.keys(cfg.tlsDnsEnvVars)) {
    dnsEnvVars[name] = `\${${name}}`;
  }
  const yaml = renderTraefikOverride({
    mode: cfg.mode,
    domain: cfg.domain,
    tlsEmail: cfg.tlsEmail,
    dnsProvider: cfg.tlsDnsProvider,
    dnsEnvVars,
    lanIp: cfg.lanIp,
  });
  if (!yaml) {
    // public-alpn / dns-01 / self-ca all return non-null overrides.
    // If we hit this, something upstream let an unexpected mode through.
    throw new Error("runReconfigure: render produced null — bug");
  }
  writeFileSync(overridePath, yaml, { mode: 0o644 });
  onLog(`wrote new override (mode: ${cfg.mode})`);

  // Always ensure COMPOSE_FILE references the override. localhost-origin
  // installs never set this var at install time, so a localhost→real-domain
  // reconfigure would otherwise leave compose ignoring the override file
  // we just wrote, and Traefik would come up without the new TLS config.
  const envUpdates: Record<string, string> = {
    COMPOSE_FILE: "docker-compose.yml:traefik.override.yml",
    ...cfg.tlsDnsEnvVars,
  };
  upsertEnvVars(composeDir, envUpdates);
  onLog("updated .env (COMPOSE_FILE + DNS env vars if any)");

  onLog("restarting traefik…");
  await restartService(composeDir, "traefik", onLog);

  onLog("verifying cert validity (up to 90s)…");
  const deadline = Date.now() + (cfg.mode === "self-ca" ? 15_000 : 90_000);
  let cert: ReturnType<typeof probeServingCert> | null = null;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      cert = probeServingCert("127.0.0.1", 443, cfg.domain);
      if (!cert.isTraefikDefault) break;
      lastErr = "still serving Traefik default cert";
    } catch (err) {
      lastErr = err instanceof Error ? err.message : "probe failed";
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  const failed = !cert || cert.isTraefikDefault;
  if (failed) {
    const reason = cert?.isTraefikDefault
      ? `Traefik is serving its default self-signed cert. ${explainAcmeFailure(cfg.mode)}`
      : `Cert probe failed: ${lastErr}`;
    if (!opts.noRollback && existsSync(prevPath)) {
      onLog("reconfigure failed — rolling back");
      copyFileSync(prevPath, overridePath);
      unlinkSync(prevPath);
      await restartService(composeDir, "traefik", onLog);
      throw new Error(`Reconfigure failed and rolled back. Reason: ${reason}`);
    }
    throw new Error(reason);
  }

  if (existsSync(prevPath)) unlinkSync(prevPath);
  onLog(
    `reconfigure ok — issuer: ${cert!.issuerO ?? cert!.issuerCN}, expires ${cert!.notAfter.toISOString()}`,
  );
}

export function upsertEnvVars(composeDir: string, vars: Record<string, string>): void {
  const envPath = join(composeDir, ".env");
  let text = "";
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    // Real installs always have .env — this is defensive.
  }
  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    if (re.test(text)) {
      text = text.replace(re, `${k}=${v}`);
    } else {
      text += (text.endsWith("\n") || !text ? "" : "\n") + `${k}=${v}\n`;
    }
  }
  writeFileSync(envPath, text, { mode: 0o600 });
}
