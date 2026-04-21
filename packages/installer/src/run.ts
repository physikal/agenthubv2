import { randomPassword } from "./lib/secrets.js";
import type { InstallConfig } from "./lib/config.js";
import {
  findComposeDir,
  writeEnvFile,
  composePull,
  composeUp,
} from "./lib/compose.js";

/**
 * Shared install runner used by both the interactive app and the headless
 * path. Returns the final URL the user should visit.
 */
export async function runInstall(
  cfg: InstallConfig,
  onLog: (line: string) => void,
): Promise<string> {
  // Generate an admin password if the user left it blank. Stored in .env so
  // the server's seed path picks it up on first boot.
  const final: InstallConfig = {
    ...cfg,
    adminPassword: cfg.adminPassword || randomPassword(20),
  };

  const composeDir = findComposeDir();
  const envFile = writeEnvFile(final, composeDir);
  onLog(`wrote ${envFile}`);

  onLog("pulling images (this can take a minute)…");
  await composePull({
    composeDir,
    envFile,
    withDokployOverlay: final.mode === "dokploy-local",
    onLine: onLog,
  });

  onLog("starting services…");
  await composeUp({
    composeDir,
    envFile,
    withDokployOverlay: final.mode === "dokploy-local",
    onLine: onLog,
  });

  const scheme = final.domain === "localhost" ? "http" : "https";
  return `${scheme}://${final.domain}`;
}
