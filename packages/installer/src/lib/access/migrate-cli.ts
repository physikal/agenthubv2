#!/usr/bin/env node
import { migrateAccessConfig } from "./migrate.js";

function main(): void {
  const composeDir = process.argv[2];
  if (!composeDir) {
    console.error("usage: migrate-cli.js <composeDir>");
    process.exit(2);
  }
  try {
    const r = migrateAccessConfig(composeDir);
    console.log(`[migrate-access] ${r.action}`);
    for (const w of r.warnings) {
      console.warn(`[migrate-access] WARN: ${w}`);
    }
  } catch (err) {
    console.error(
      "[migrate-access] failed:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }
}

main();
