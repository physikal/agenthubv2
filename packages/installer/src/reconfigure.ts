import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { findComposeDir, restartService } from "./lib/compose.js";
import {
  renderTraefikStaticConfig,
  renderTraefikOverride,
  renderRedirectDynamic,
} from "./lib/access/render-compose.js";
import { probeServingCert } from "./lib/tls/probe-cert.js";
import { explainAcmeFailure } from "./headless.js";
import type { AccessMode, PublicTlsMode } from "./lib/access/types.js";

export interface ReconfigureConfig {
  accessMode: AccessMode;
  /** Required when accessMode === "public". */
  publicTlsMode?: PublicTlsMode;
  domain: string;
  tlsEmail: string;
  tlsDnsProvider: string;
  tlsDnsEnvVars: Record<string, string>;
}

export interface ReconfigureOptions {
  /** Default false: on cert-validity failure, restore the prior override. */
  noRollback?: boolean;
}

/**
 * Reconfigure access mode for an existing install. Atomic: snapshots prior
 * override, writes new configs, restarts Traefik, validates reachability
 * (and cert for public mode), rolls back on failure.
 */
export async function runReconfigure(
  cfg: ReconfigureConfig,
  onLog: (line: string) => void,
  opts: ReconfigureOptions = {},
): Promise<void> {
  const composeDir = findComposeDir();
  const overridePath = join(composeDir, "traefik.override.yml");
  const prevPath = join(composeDir, "traefik.override.yml.prev");
  const dynamicDir = join(composeDir, "dynamic");
  const redirectPath = join(dynamicDir, "redirect.yml");

  if (existsSync(overridePath)) {
    copyFileSync(overridePath, prevPath);
    onLog(`snapshot: ${overridePath} -> ${prevPath}`);
  }

  // Render and write Traefik's static config. This always gets rewritten so
  // entrypoints + cert resolver reflect the new access mode.
  const dnsEnvVarsPlaceholders: Record<string, string> = {};
  for (const name of Object.keys(cfg.tlsDnsEnvVars)) {
    dnsEnvVarsPlaceholders[name] = `\${${name}}`;
  }

  const renderInput: import("./lib/access/render-compose.js").RenderInput = {
    accessMode: cfg.accessMode,
    domain: cfg.domain,
    publicTlsMode: cfg.publicTlsMode as PublicTlsMode | undefined,
    tlsEmail: cfg.tlsEmail,
    ...(cfg.tlsDnsProvider ? { dnsProvider: cfg.tlsDnsProvider } : {}),
    dnsEnvVars: dnsEnvVarsPlaceholders,
  };

  const traefikYaml = renderTraefikStaticConfig(renderInput);
  writeFileSync(join(composeDir, "traefik.yml"), traefikYaml, { mode: 0o644 });
  onLog(`wrote ${join(composeDir, "traefik.yml")} (access: ${cfg.accessMode})`);

  // Render the override file. Null for lan mode — delete any existing one.
  const overrideYaml = renderTraefikOverride(renderInput);
  if (overrideYaml) {
    writeFileSync(overridePath, overrideYaml, { mode: 0o644 });
    onLog(`wrote new override (access: ${cfg.accessMode}, tls: ${cfg.publicTlsMode ?? "none"})`);
  } else if (existsSync(overridePath)) {
    unlinkSync(overridePath);
    onLog(`removed ${overridePath} (lan mode — no override needed)`);
  }

  // Render redirect.yml. Null for lan — delete if present (no HTTPS endpoint).
  const redirectYaml = renderRedirectDynamic({ accessMode: cfg.accessMode });
  if (redirectYaml) {
    if (!existsSync(dynamicDir)) mkdirSync(dynamicDir, { recursive: true, mode: 0o755 });
    writeFileSync(redirectPath, redirectYaml, { mode: 0o644 });
    onLog(`wrote ${redirectPath}`);
  } else if (existsSync(redirectPath)) {
    unlinkSync(redirectPath);
    onLog(`removed ${redirectPath} (lan mode — no HTTPS redirect needed)`);
  }

  // Update .env: COMPOSE_FILE references the override only in public mode.
  // Always update DNS env vars if provided.
  const envUpdates: Record<string, string> = {};
  if (cfg.accessMode === "public") {
    envUpdates["COMPOSE_FILE"] = "docker-compose.yml:traefik.override.yml";
  } else {
    // LAN mode: remove override from COMPOSE_FILE if it was previously set.
    const envPath = join(composeDir, ".env");
    let envText = "";
    try {
      envText = readFileSync(envPath, "utf8");
    } catch {
      // Defensive — installs always have .env.
    }
    const hasOverrideInFile = /^COMPOSE_FILE=.*traefik\.override\.yml/m.test(envText);
    if (hasOverrideInFile) {
      envText = envText.replace(
        /^COMPOSE_FILE=.*$/m,
        "COMPOSE_FILE=docker-compose.yml",
      );
      writeFileSync(envPath, envText, { mode: 0o600 });
      onLog("updated .env: removed override from COMPOSE_FILE (lan mode)");
    }
  }
  if (Object.keys(cfg.tlsDnsEnvVars).length > 0) {
    Object.assign(envUpdates, cfg.tlsDnsEnvVars);
  }
  if (Object.keys(envUpdates).length > 0) {
    upsertEnvVars(composeDir, envUpdates);
    onLog("updated .env (COMPOSE_FILE + DNS env vars if any)");
  }

  onLog("restarting traefik…");
  await restartService(composeDir, "traefik", onLog);

  // Probe — http for lan, https (cert check) for public.
  if (cfg.accessMode === "lan") {
    onLog("verifying lan reachability (up to 30s)…");
    const deadline = Date.now() + 30_000;
    let reachable = false;
    let lastErr = "";
    while (Date.now() < deadline) {
      try {
        const { execFileSync } = await import("node:child_process");
        execFileSync("curl", ["-sf", "-m", "5", `http://${cfg.domain}/api/health`], {
          stdio: "pipe",
        });
        reachable = true;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : "curl failed";
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    if (!reachable) {
      const reason = `LAN probe failed: ${lastErr}`;
      if (!opts.noRollback && existsSync(prevPath)) {
        onLog("reconfigure failed — rolling back");
        copyFileSync(prevPath, overridePath);
        unlinkSync(prevPath);
        await restartService(composeDir, "traefik", onLog);
        throw new Error(`Reconfigure failed and rolled back. Reason: ${reason}`);
      }
      throw new Error(reason);
    }
  } else {
    onLog("verifying cert validity (up to 90s)…");
    const deadline = Date.now() + 90_000;
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
        ? `Traefik is serving its default self-signed cert. ${explainAcmeFailure(cfg.publicTlsMode ?? "public")}`
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
    onLog(
      `reconfigure ok — issuer: ${cert!.issuerO ?? cert!.issuerCN}, expires ${cert!.notAfter.toISOString()}`,
    );
  }

  if (existsSync(prevPath)) unlinkSync(prevPath);
  if (cfg.accessMode === "lan") {
    onLog("reconfigure ok — lan mode active");
  }
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
