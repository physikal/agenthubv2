import { execFileSync } from "node:child_process";
import {
  applyEnvOverrides,
  emptyConfig,
  missingRequiredForHeadless,
} from "./lib/config.js";
import { runInstall } from "./run.js";
import { randomPassword } from "./lib/secrets.js";

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
 * Front-door probe. Hits the advertised URL through Traefik so we catch
 * routing / TLS / Docker-provider failures that an in-container app-logic
 * E2E would miss. `--resolve` sidesteps DNS so real-domain installs don't
 * fail the probe just because their A record hasn't propagated yet.
 */
function probeFrontDoor(domain: string): void {
  try {
    execFileSync(
      "curl",
      [
        "-ksf",
        "-m", "10",
        "--resolve", `${domain}:443:127.0.0.1`,
        `https://${domain}/api/health`,
      ],
      { stdio: "pipe" },
    );
  } catch {
    throw new Error(
      `Install completed but https://${domain}/api/health is unreachable through the front-door proxy. ` +
        `Check 'docker logs agenthub-traefik-1' for routing or Docker-provider errors.`,
    );
  }
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

  try {
    const art = await runInstall(cfg, (line) => console.log(line));
    console.log("verifying front-door routing via Traefik…");
    probeFrontDoor(cfg.domain);
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
