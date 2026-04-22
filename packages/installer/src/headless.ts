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
