import { randomUUID } from "crypto";
import { execSync } from "child_process";
import { db } from "../../db/index.js";
import { installBackupConfig, installBackupRuns } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { createBundle } from "./bundler.js";
import { b2Push } from "./b2-client.js";
import { pruneLocal, pruneB2 } from "./retention.js";
import type { B2Config, BackupRunSummary } from "./types.js";
import { getSecretStore } from "../secrets/index.js";

const BACKUPS_DIR = "/data/install-backups";
const SYSTEM_SECRET_PATH = "/system/install-backup";
const B2_APP_KEY_NAME = "b2_app_key";

export async function loadB2Config(): Promise<B2Config | null> {
  const rows = await db.select().from(installBackupConfig).where(eq(installBackupConfig.id, 1));
  const row = rows[0];
  if (!row) return null;
  if (!row.b2KeyId || !row.b2Bucket) return null;
  const store = getSecretStore();
  if (!store.configured) return null;
  const appKey = await store.getSecret(SYSTEM_SECRET_PATH, B2_APP_KEY_NAME);
  if (!appKey) return null;
  const cfg: B2Config = {
    keyId: row.b2KeyId,
    appKey,
    bucket: row.b2Bucket,
    pathPrefix: row.b2PathPrefix ?? "installs/",
  };
  // Backend defaults to "b2" when the column is null (back-compat).
  if (row.backend === "s3") {
    cfg.backend = "s3";
    if (row.endpoint) cfg.endpoint = row.endpoint;
    if (row.region) cfg.region = row.region;
  }
  return cfg;
}

export async function saveB2AppKey(appKey: string): Promise<void> {
  const store = getSecretStore();
  await store.setSecret(SYSTEM_SECRET_PATH, B2_APP_KEY_NAME, appKey);
}

export async function loadRetentionKeepLast(): Promise<number> {
  const rows = await db.select().from(installBackupConfig).where(eq(installBackupConfig.id, 1));
  const row = rows[0];
  return row?.retentionKeepLast ?? 10;
}

export interface RunOptions {
  trigger: "manual" | "auto-update" | "cli";
  note?: string;
  noB2?: boolean;
  onLog?: (line: string) => void;
}

export async function runBackup(opts: RunOptions): Promise<BackupRunSummary> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const log = opts.onLog ?? ((_l: string) => {});

  await db.insert(installBackupRuns).values({
    id: runId,
    startedAt,
    status: "running",
    trigger: opts.trigger,
    note: opts.note ?? null,
  });

  try {
    const sourceDomain = process.env["AGENTHUB_DOMAIN"] ?? "localhost";
    const gitSha = readGitSha();

    log(`[backup] starting bundle (trigger=${opts.trigger}, source=${sourceDomain})`);
    const bundle = await createBundle({
      trigger: opts.trigger,
      ...(opts.note ? { note: opts.note } : {}),
      sourceDomain,
      gitSha,
    });
    log(`[backup] bundle written: ${bundle.bundlePath} (${bundle.bytes} bytes)`);

    let b2Path: string | null = null;
    if (!opts.noB2) {
      const cfg = await loadB2Config();
      if (cfg) {
        log(`[backup] pushing to B2 bucket ${cfg.bucket}/${cfg.pathPrefix}${bundle.filename}`);
        await b2Push(cfg, bundle.bundlePath, bundle.filename, (l) => log(`[rclone] ${l}`));
        b2Path = `b2://${cfg.bucket}/${cfg.pathPrefix}${bundle.filename}`;
        log(`[backup] uploaded to B2`);
      } else {
        log(`[backup] B2 not configured; local-only`);
      }
    }

    const keepLast = await loadRetentionKeepLast();
    if (keepLast > 0) {
      const localPruned = pruneLocal(BACKUPS_DIR, keepLast);
      if (localPruned.length > 0) log(`[backup] pruned ${localPruned.length} old local bundle(s)`);
      if (b2Path) {
        const cfg = await loadB2Config();
        if (cfg) {
          const b2Pruned = await pruneB2(cfg, keepLast);
          if (b2Pruned.length > 0) log(`[backup] pruned ${b2Pruned.length} old B2 bundle(s)`);
        }
      }
    }

    const finishedAt = new Date().toISOString();
    await db.update(installBackupRuns).set({
      finishedAt,
      status: "ok",
      bytes: bundle.bytes,
      localPath: bundle.bundlePath,
      b2Path,
    }).where(eq(installBackupRuns.id, runId));

    return {
      id: runId,
      startedAt,
      finishedAt,
      status: "ok",
      bytes: bundle.bytes,
      localPath: bundle.bundlePath,
      b2Path,
      trigger: opts.trigger,
      error: null,
      note: opts.note ?? null,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`[backup] FAILED: ${errMsg}`);
    await db.update(installBackupRuns).set({
      finishedAt: new Date().toISOString(),
      status: "failed",
      error: errMsg,
    }).where(eq(installBackupRuns.id, runId));
    throw err;
  }
}

function readGitSha(): string {
  try {
    return execSync("git -C /repo rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
