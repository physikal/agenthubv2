#!/usr/bin/env node
/**
 * `agenthub reconfigure-access` CLI entry. Two modes:
 *   - interactive: launches the TUI (reconfigure-app.tsx)
 *   - --non-interactive: reads env vars and runs runReconfigure directly
 *
 * Flags:
 *   --non-interactive       headless mode
 *   --no-rollback           don't restore prior override on probe failure
 *
 * Non-interactive env vars:
 *   AGENTHUB_ACCESS_MODE    "lan" | "public"  (required)
 *   AGENTHUB_TLS_MODE       "public-alpn" | "dns-01"  (required when access=public)
 *   AGENTHUB_TLS_EMAIL      email for Let's Encrypt  (required when access=public)
 *   AGENTHUB_TLS_DNS_PROVIDER  lego provider name (required when tls=dns-01)
 *   CF_DNS_API_TOKEN / AGENTHUB_CLOUDFLARE_API_TOKEN  (for cloudflare dns-01)
 */
import { applyEnvOverrides, emptyConfig } from "./lib/config.js";
import { resolveAccessMode, resolvePublicTlsMode } from "./lib/access/resolve-mode.js";
import { runReconfigure } from "./reconfigure.js";

const args = process.argv.slice(2);
const nonInteractive = args.includes("--non-interactive");
const noRollback = args.includes("--no-rollback");

async function runHeadless(): Promise<void> {
  const cfg = applyEnvOverrides(emptyConfig());
  const resolvedAccessMode = resolveAccessMode(cfg.accessMode, cfg.domain, process.env);

  if (resolvedAccessMode === "lan" && cfg.domain === "localhost") {
    console.error(
      "reconfigure-access: localhost installs use lan mode by default. " +
        "Change AGENTHUB_DOMAIN to a real hostname to reconfigure.",
    );
    process.exit(2);
  }

  const publicTlsMode =
    resolvedAccessMode === "public"
      ? resolvePublicTlsMode(cfg.tlsMode, process.env)
      : undefined;

  try {
    await runReconfigure(
      {
        accessMode: resolvedAccessMode,
        ...(publicTlsMode !== undefined ? { publicTlsMode } : {}),
        domain: cfg.domain,
        tlsEmail: cfg.tlsEmail,
        tlsDnsProvider: cfg.tlsDnsProvider,
        tlsDnsEnvVars: cfg.tlsDnsEnvVars,
      },
      (line) => console.log(line),
      { noRollback },
    );
    console.log("reconfigure ok");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(3);
  }
}

async function runInteractive(): Promise<void> {
  const { default: launchReconfigureApp } = await import("./reconfigure-app.js");
  await launchReconfigureApp({ noRollback });
}

if (nonInteractive) {
  void runHeadless();
} else {
  void runInteractive();
}
