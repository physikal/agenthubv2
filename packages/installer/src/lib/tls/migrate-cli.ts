#!/usr/bin/env node
/**
 * CLI entry point for migrateTlsConfig — invoked by `scripts/agenthub update`.
 * Exits 0 on success (incl. no-op cases), non-zero on failure with a clear msg.
 */
import { migrateTlsConfig } from "./migrate.js";

function main(): void {
  const composeDir = process.argv[2];
  if (!composeDir) {
    console.error("usage: migrate-cli.js <composeDir>");
    process.exit(2);
  }
  try {
    const r = migrateTlsConfig(composeDir);
    if (r.action === "migrated") {
      console.log(
        `[migrate-tls] generated ${r.overridePath} (mode: ${r.inferredMode})`,
      );
    } else if (r.action === "noop-already-migrated") {
      console.log("[migrate-tls] already migrated, no changes");
    } else if (r.action === "noop-localhost") {
      console.log("[migrate-tls] localhost install, no override needed");
    }
  } catch (err) {
    console.error(
      "[migrate-tls] migration failed:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }
}

main();
