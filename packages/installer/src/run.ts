import {
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomPassword } from "./lib/secrets.js";
import type { InstallConfig } from "./lib/config.js";
import { renderEnv } from "./lib/config.js";
import {
  findComposeDir,
  writeEnvFile,
  composePull,
  composeUp,
  recreateService,
} from "./lib/compose.js";
import { bootstrapInfisical } from "./lib/infisical-bootstrap.js";
import {
  renderTraefikStaticConfig,
  renderTraefikOverride,
  renderRedirectDynamic,
} from "./lib/access/render-compose.js";
import { resolveAccessMode, resolvePublicTlsMode } from "./lib/access/resolve-mode.js";

export interface InstallArtifacts {
  url: string;
  adminPassword: string;
  infisicalAdminEmail: string;
  infisicalAdminPassword: string;
}

/**
 * Shared install runner used by both interactive and headless paths.
 */
export async function runInstall(
  cfg: InstallConfig,
  onLog: (line: string) => void,
): Promise<InstallArtifacts> {
  // Generate an admin password if blank. Persisted to .env so the server's
  // initDb() seeds it on first boot.
  const final: InstallConfig = {
    ...cfg,
    adminPassword: cfg.adminPassword || randomPassword(20),
  };

  const composeDir = findComposeDir();
  const envFile = writeEnvFile(final, composeDir);
  onLog(`wrote ${envFile}`);

  // Generate compose/traefik.yml — Traefik's static config, mounted via
  // base compose's --configfile. Always emitted.
  writeTraefikConfig(final, composeDir, onLog);

  // Generate compose/dynamic/redirect.yml — Traefik's dynamic config
  // (http → https redirect router + middleware + stub service).
  // Loaded via the file provider. Emitted for public mode only (lan = no HTTPS).
  writeTraefikDynamicConfig(final, composeDir, onLog);

  // Generate compose/traefik.override.yml — cert-resolver labels + DNS
  // provider env vars for public mode. lan mode: no override file written.
  writeTraefikOverride(final, composeDir, onLog);

  onLog("pulling images…");
  await composePull({ composeDir, envFile, onLine: onLog });

  onLog("starting services…");
  await composeUp({ composeDir, envFile, onLine: onLog });

  // Bootstrap Infisical first-run setup: create admin, org, project, machine
  // identity, and write INFISICAL_PROJECT_ID/CLIENT_ID/CLIENT_SECRET back to
  // .env. Then recreate the server so it picks up the real creds (it booted
  // earlier with UnconfiguredStore).
  //
  // Skip bootstrap when AGENTHUB_INFISICAL_EXTERNAL=true. In this mode the
  // operator brings their own Infisical instance (existing self-hosted or
  // Infisical Cloud), and is expected to provide the four INFISICAL_URL /
  // PROJECT_ID / CLIENT_ID / CLIENT_SECRET vars themselves. Bootstrap is
  // skipped + the bundled `infisical` service in compose/.env is expected to
  // be either disabled or unused. See docs/install/agents.md.
  const skipBootstrap =
    process.env["AGENTHUB_INFISICAL_EXTERNAL"] === "true" ||
    process.env["AGENTHUB_INFISICAL_EXTERNAL"] === "1";
  let postBootstrap: InstallConfig = final;
  if (skipBootstrap) {
    onLog("AGENTHUB_INFISICAL_EXTERNAL=true — skipping Infisical bootstrap.");
    if (!final.infisicalProjectId || !final.infisicalClientId || !final.infisicalClientSecret) {
      throw new Error(
        "AGENTHUB_INFISICAL_EXTERNAL=true but INFISICAL_PROJECT_ID/CLIENT_ID/" +
          "CLIENT_SECRET are not set. Set them in your environment or .env " +
          "before running the installer.",
      );
    }
  } else {
    const bootstrap = await bootstrapInfisical(
      {
        baseUrl: "http://localhost:8080",
        adminEmail: "admin@agenthub.local",
        orgName: "AgentHub",
        projectName: "agenthub",
        composeDir,
        envFile,
      },
      onLog,
    );

    // Merge bootstrap results into .env. Admin email/password are persisted
    // so the operator can retrieve them later via the Secrets page "Reveal
    // Infisical login" flow — Infisical disables self-registration by
    // default.
    postBootstrap = {
      ...final,
      infisicalProjectId: bootstrap.projectId,
      infisicalClientId: bootstrap.clientId,
      infisicalClientSecret: bootstrap.clientSecret,
      infisicalAdminEmail: bootstrap.adminEmail,
      infisicalAdminPassword: bootstrap.adminPassword,
    };
    writeFileSync(envFile, renderEnv(postBootstrap), { mode: 0o600 });
    onLog("wrote Infisical creds to .env");
  }

  onLog("restarting agenthub-server with secret store enabled…");
  await recreateService({
    composeDir,
    envFile,
    service: "agenthub-server",
    onLine: onLog,
  });

  const scheme = final.domain === "localhost" ? "http" : "https";
  const url = `${scheme}://${final.domain}`;

  return {
    url,
    adminPassword: postBootstrap.adminPassword,
    // Empty strings on the external-Infisical path — the operator has
    // their own admin login flow there.
    infisicalAdminEmail: postBootstrap.infisicalAdminEmail,
    infisicalAdminPassword: postBootstrap.infisicalAdminPassword,
  };
}

// Kept for backwards-compat with the earlier app.tsx signature that expected
// a single URL — will remove once the UI consumes InstallArtifacts.
export async function runInstallSimple(
  cfg: InstallConfig,
  onLog: (line: string) => void,
): Promise<string> {
  const res = await runInstall(cfg, onLog);
  return res.url;
}

function writeTraefikConfig(
  cfg: InstallConfig,
  composeDir: string,
  onLog: (line: string) => void,
): void {
  const accessMode = resolveAccessMode(cfg.accessMode, cfg.domain, process.env);
  const publicTlsMode =
    accessMode === "public"
      ? resolvePublicTlsMode(cfg.tlsMode, process.env)
      : undefined;
  const yaml = renderTraefikStaticConfig({
    accessMode,
    domain: cfg.domain,
    publicTlsMode,
    tlsEmail: cfg.tlsEmail,
    ...(cfg.tlsDnsProvider ? { dnsProvider: cfg.tlsDnsProvider } : {}),
    dnsEnvVars: cfg.tlsDnsEnvVars,
  });
  const path = join(composeDir, "traefik.yml");
  writeFileSync(path, yaml, { mode: 0o644 });
  onLog(`wrote ${path} (mode: ${accessMode}${publicTlsMode ? `/${publicTlsMode}` : ""})`);
}

function writeTraefikDynamicConfig(
  cfg: InstallConfig,
  composeDir: string,
  onLog: (line: string) => void,
): void {
  const accessMode = resolveAccessMode(cfg.accessMode, cfg.domain, process.env);
  const dynamicDir = join(composeDir, "dynamic");
  if (!existsSync(dynamicDir)) {
    // 0755 so Traefik (running as root in its container) can read.
    mkdirSync(dynamicDir, { recursive: true, mode: 0o755 });
  }
  const yaml = renderRedirectDynamic({ accessMode });
  // lan mode: no HTTPS redirect needed — omit the file entirely.
  if (!yaml) {
    onLog(`skipped redirect.yml (lan mode — no HTTPS redirect)`);
    return;
  }
  const path = join(dynamicDir, "redirect.yml");
  writeFileSync(path, yaml, { mode: 0o644 });
  onLog(`wrote ${path}`);
}

function writeTraefikOverride(
  cfg: InstallConfig,
  composeDir: string,
  onLog: (line: string) => void,
): void {
  const accessMode = resolveAccessMode(cfg.accessMode, cfg.domain, process.env);
  const publicTlsMode =
    accessMode === "public"
      ? resolvePublicTlsMode(cfg.tlsMode, process.env)
      : undefined;
  const overridePath = join(composeDir, "traefik.override.yml");
  if (accessMode === "lan") {
    if (existsSync(overridePath)) {
      unlinkSync(overridePath);
      onLog(`removed ${overridePath} (lan install)`);
    }
    return;
  }
  // DNS env-var values in the override file are ${VAR} placeholders so
  // docker compose substitutes from .env at run time. Secrets stay in .env
  // (mode 0600), the override is non-secret YAML.
  const dnsEnvVars: Record<string, string> = {};
  for (const name of Object.keys(cfg.tlsDnsEnvVars)) {
    dnsEnvVars[name] = `\${${name}}`;
  }
  const yaml = renderTraefikOverride({
    accessMode,
    domain: cfg.domain,
    publicTlsMode,
    tlsEmail: cfg.tlsEmail,
    ...(cfg.tlsDnsProvider ? { dnsProvider: cfg.tlsDnsProvider } : {}),
    dnsEnvVars,
  });
  if (!yaml) return;
  writeFileSync(overridePath, yaml, { mode: 0o644 });
  onLog(`wrote ${overridePath} (mode: ${accessMode}${publicTlsMode ? `/${publicTlsMode}` : ""})`);
}

