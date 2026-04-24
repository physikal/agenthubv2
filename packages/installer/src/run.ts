import { readFileSync, writeFileSync } from "node:fs";
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

  onLog("pulling images…");
  await composePull({ composeDir, envFile, onLine: onLog });

  onLog("starting services…");
  await composeUp({ composeDir, envFile, onLine: onLog });

  // Bootstrap Infisical first-run setup: create admin, org, project, machine
  // identity, and write INFISICAL_PROJECT_ID/CLIENT_ID/CLIENT_SECRET back to
  // .env. Then recreate the server so it picks up the real creds (it booted
  // earlier with UnconfiguredStore).
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

  // Merge bootstrap results into .env. Admin email/password are persisted so
  // the operator can retrieve them later via the Secrets page "Reveal
  // Infisical login" flow — Infisical disables self-registration by default.
  const next: InstallConfig = {
    ...final,
    infisicalProjectId: bootstrap.projectId,
    infisicalClientId: bootstrap.clientId,
    infisicalClientSecret: bootstrap.clientSecret,
    infisicalAdminEmail: bootstrap.adminEmail,
    infisicalAdminPassword: bootstrap.adminPassword,
  };
  writeFileSync(envFile, renderEnv(next), { mode: 0o600 });
  onLog("wrote Infisical creds to .env");

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
    adminPassword: final.adminPassword,
    infisicalAdminEmail: bootstrap.adminEmail,
    infisicalAdminPassword: bootstrap.adminPassword,
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

// Silence unused-import warning until headless.ts picks up readFileSync.
void readFileSync;
