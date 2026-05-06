#!/usr/bin/env node
/**
 * `agenthub reconfigure-tls` CLI entry. Two modes:
 *   - interactive: launches the reduced TUI (reconfigure-app.tsx)
 *   - --non-interactive: reads env vars (same names as install) and runs
 *     runReconfigure directly
 *
 * Flags:
 *   --non-interactive       headless mode
 *   --no-rollback           don't restore prior override on probe failure
 *   --regen-cert            self-ca only: force leaf regeneration
 */
import { applyEnvOverrides, emptyConfig } from "./lib/config.js";
import { resolveTlsMode } from "./lib/tls/resolve-mode.js";
import { runReconfigure } from "./reconfigure.js";

const args = process.argv.slice(2);
const nonInteractive = args.includes("--non-interactive");
const noRollback = args.includes("--no-rollback");
const regenCert = args.includes("--regen-cert");

async function runHeadless(): Promise<void> {
  const cfg = applyEnvOverrides(emptyConfig());
  const resolved = resolveTlsMode(cfg.tlsMode, cfg.domain, process.env);
  if (resolved === "none") {
    console.error(
      "reconfigure-tls: localhost installs have no override to reconfigure. " +
        "Change AGENTHUB_DOMAIN to a real hostname and set AGENTHUB_TLS_MODE.",
    );
    process.exit(2);
  }
  if (resolved === "self-ca" && !cfg.lanIp) {
    const { detectLanIp } = await import("./lib/tls/lan-ip.js");
    cfg.lanIp = detectLanIp();
    console.log(`auto-detected LAN IP: ${cfg.lanIp}`);
  }
  try {
    await runReconfigure(
      {
        mode: resolved,
        domain: cfg.domain,
        tlsEmail: cfg.tlsEmail,
        tlsDnsProvider: cfg.tlsDnsProvider,
        tlsDnsEnvVars: cfg.tlsDnsEnvVars,
        lanIp: cfg.lanIp,
      },
      (line) => console.log(line),
      { noRollback, regenCert },
    );
    console.log("reconfigure ok");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(3);
  }
}

async function runInteractive(): Promise<void> {
  const { default: launchReconfigureApp } = await import("./reconfigure-app.js");
  await launchReconfigureApp({ noRollback, regenCert });
}

if (nonInteractive) {
  void runHeadless();
} else {
  void runInteractive();
}
