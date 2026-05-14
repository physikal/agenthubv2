#!/usr/bin/env node
// Restore-install entrypoint — runs in a temp container via `agenthub restore-install`.
// Shipped in the server image at /app/scripts/restore-install.js.
// The server image copies scripts/ into /app/scripts/ (see docker/Dockerfile.server).
//
// Must be plain ESM: the server dist uses "type": "module".

import {
  resolveSource,
  extractAndValidate,
  buildConflictReport,
  applyRestore,
} from "/app/packages/server/dist/services/install-backup/restorer.js";
import { loadB2Config } from "/app/packages/server/dist/services/install-backup/runner.js";
import Database from "better-sqlite3";

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let source;
  if (args.from) {
    if (args.from.startsWith("b2://")) {
      source = { kind: "b2-url", url: args.from };
    } else {
      source = { kind: "local", path: args.from };
    }
  } else if (args.snapshot) {
    source = { kind: "b2-snapshot", snapshot: args.snapshot };
  } else {
    fail("missing --from or --snapshot");
  }

  const log = (line) => process.stdout.write(line + "\n");

  log("[restore] resolving source");
  const cfg = await loadB2Config();
  const localPath = await resolveSource(source, cfg);

  log(`[restore] extracting ${localPath}`);
  const bundle = await extractAndValidate(localPath);
  log(`[restore] manifest: ${bundle.manifest.sourceDomain} @ ${bundle.manifest.createdAt}`);

  if (args.dryRun) {
    log("[restore] dry-run OK — no changes applied");
    return;
  }

  if (!args.force) {
    // Query SQLite directly — the live server may be empty or stopped.
    const dbPath = "/data/agenthub.db";
    let userCount = 0;
    let activeSessionCount = 0;
    try {
      const sdb = new Database(dbPath, { readonly: true });
      userCount = sdb.prepare("SELECT count(*) AS c FROM users").get()?.c ?? 0;
      activeSessionCount =
        sdb
          .prepare(
            "SELECT count(*) AS c FROM sessions WHERE status NOT IN ('destroyed','failed')",
          )
          .get()?.c ?? 0;
      sdb.close();
    } catch {
      // DB may not exist on a fresh VM — treat as zero rows.
    }

    const report = buildConflictReport(bundle, {
      b2Config: cfg,
      userCount,
      secretCount: 0, // conservative; encryption-key-mismatch guard still fires via currentEnvEncryptionKey
      activeSessionCount,
      currentEnvEncryptionKey: process.env["INFISICAL_ENCRYPTION_KEY"] ?? "",
    });

    if (!report.ok) {
      log("[restore] conflicts detected — use --force to override:");
      for (const c of report.conflicts) {
        log(`  - ${c.kind}: ${c.detail}`);
      }
      process.exit(4);
    }
  }

  const project = process.env["COMPOSE_PROJECT_NAME"] ?? "agenthub";
  await applyRestore(bundle, project, log);
  log("[restore] complete — verify https://<domain>/api/health");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") {
      out.from = argv[++i];
    } else if (argv[i] === "--snapshot") {
      out.snapshot = argv[++i];
    } else if (argv[i] === "--force") {
      out.force = true;
    } else if (argv[i] === "--dry-run") {
      out.dryRun = true;
    }
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`[restore] FAILED: ${err.stack ?? err.message ?? String(err)}\n`);
  process.exit(1);
});
