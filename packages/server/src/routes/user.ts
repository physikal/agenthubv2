import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, chownSync } from "node:fs";
import { promisify } from "node:util";
import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { AuthUser } from "../middleware/auth.js";
import {
  assertSafeB2Credential,
  assertSafeBucketName,
  assertSafeUserId,
} from "../services/shell-safety.js";

// RFC3339-ish: 2024-01-15T12:30:00.000Z or with +hh:mm offset. Strict enough
// to reject anything that could confuse rclone's flag parser; loose enough to
// accept whatever `new Date().toISOString()` produces on the client.
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

const execFileAsync = promisify(execFile);

interface BackupConfig {
  b2KeyId: string;
  b2AppKey: string;
  b2Bucket: string;
}

/**
 * Validate stored config before using in shell commands. Throws if any field
 * fails the allowlist check — fail-closed. Older rows with invalid data
 * should refuse to run rather than silently allow injection.
 */
function validateBackupConfig(config: BackupConfig): void {
  assertSafeB2Credential(config.b2KeyId, "b2KeyId");
  assertSafeB2Credential(config.b2AppKey, "b2AppKey");
  assertSafeBucketName(config.b2Bucket);
}

function maskKey(key: string): string {
  if (key.length <= 4) return "\u2022".repeat(key.length);
  return "\u2022".repeat(key.length - 4) + key.slice(-4);
}

function getBackupConfig(userId: string): BackupConfig | null {
  const rows = db
    .select()
    .from(schema.userCredentials)
    .where(eq(schema.userCredentials.userId, userId))
    .all();

  if (!rows[0]?.backupConfig) return null;
  try {
    return JSON.parse(rows[0].backupConfig) as BackupConfig;
  } catch {
    return null;
  }
}

function getUsername(userId: string): string {
  const rows = db
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .all();
  return rows[0]?.username ?? userId;
}

/**
 * Write a temporary rclone config for server-side operations. Returns config path.
 * Caller must call validateBackupConfig() first — unvalidated credentials
 * with a newline would inject fake config sections (e.g. redirecting `type`).
 */
function writeRcloneConfig(userId: string, config: BackupConfig): string {
  assertSafeUserId(userId);
  validateBackupConfig(config);
  const dir = `/tmp/rclone-${userId}`;
  mkdirSync(dir, { recursive: true });
  const confPath = `${dir}/rclone.conf`;
  writeFileSync(confPath, `[b2]\ntype = b2\naccount = ${config.b2KeyId}\nkey = ${config.b2AppKey}\n`, { mode: 0o600 });
  return confPath;
}

/**
 * Run rclone with arguments passed as an argv array — never a shell string.
 *
 * Async (`execFile`) so long-running rclone calls (`sync`/`copy` with 5 min
 * timeout) don't block every other HTTP request, WebSocket upgrade, and pool
 * tick on the single Node event loop. Previously `execFileSync` could freeze
 * the whole server while one user's backup ran.
 */
async function rcloneExec(confPath: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(
    "rclone",
    ["--config", confPath, ...args],
    { timeout: timeoutMs, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout;
}

function startBackupRun(
  userId: string,
  kind: "save" | "restore",
  snapshotAt: Date | null,
): string {
  const id = randomUUID();
  db.insert(schema.backupRuns)
    .values({
      id,
      userId,
      kind,
      status: "running",
      startedAt: new Date(),
      snapshotAt,
    })
    .run();
  return id;
}

function finishBackupRun(
  id: string,
  status: "success" | "failed",
  extras: { bytes?: number | null; fileCount?: number | null; error?: string | null } = {},
): void {
  db.update(schema.backupRuns)
    .set({
      status,
      endedAt: new Date(),
      bytes: extras.bytes ?? null,
      fileCount: extras.fileCount ?? null,
      error: extras.error ?? null,
    })
    .where(eq(schema.backupRuns.id, id))
    .run();
}

async function safeRcloneSize(confPath: string, bucket: string): Promise<{ count: number; bytes: number } | null> {
  try {
    const output = await rcloneExec(confPath, ["size", bucket, "--json"], 30_000);
    return JSON.parse(output) as { count: number; bytes: number };
  } catch {
    return null;
  }
}

/**
 * Extract a useful error string from a failed execFile call. Node's default
 * `err.message` is just "Command failed: <cmd>" when stderr is empty, which
 * tells us nothing about what rclone actually complained about. We fall back
 * through stderr → stdout → exit code → message so we always surface the
 * most informative piece.
 */
function extractExecError(err: unknown, fallback: string): string {
  const e = err as { stderr?: string | Buffer; stdout?: string | Buffer; code?: number | string; message?: string };
  const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString("utf-8") ?? "";
  const stdout = typeof e.stdout === "string" ? e.stdout : e.stdout?.toString("utf-8") ?? "";
  const text = (stderr.trim() || stdout.trim()).slice(-2000);
  if (text) return text;
  if (e.code !== undefined) return `${fallback} (exit ${String(e.code)})`;
  return e.message ?? fallback;
}

export function userRoutes() {
  const app = new Hono<{ Variables: { user: AuthUser } }>();

  // --- Backup Config ---

  app.get("/backup", (c) => {
    const user = c.get("user");
    const config = getBackupConfig(user.id);
    if (!config) return c.json({ configured: false });

    return c.json({
      configured: true,
      b2KeyId: config.b2KeyId,
      b2AppKey: maskKey(config.b2AppKey),
      b2Bucket: config.b2Bucket,
    });
  });

  app.put("/backup", async (c) => {
    const user = c.get("user");
    const body = await c.req.json<BackupConfig>();

    if (!body.b2KeyId?.trim() || !body.b2AppKey?.trim() || !body.b2Bucket?.trim()) {
      return c.json({ error: "All fields required: b2KeyId, b2AppKey, b2Bucket" }, 400);
    }

    const parsed: BackupConfig = {
      b2KeyId: body.b2KeyId.trim(),
      b2AppKey: body.b2AppKey.trim(),
      b2Bucket: body.b2Bucket.trim(),
    };

    // Fail-closed validation so bad data never reaches the shell or the rclone
    // config file (where a newline in b2KeyId could inject a fake section).
    try {
      validateBackupConfig(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid config";
      return c.json({ error: msg }, 400);
    }

    const config = JSON.stringify(parsed);

    db.insert(schema.userCredentials)
      .values({ userId: user.id, backupConfig: config, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.userCredentials.userId,
        set: { backupConfig: config, updatedAt: new Date() },
      })
      .run();

    // Update rclone config on NFS if home dir exists
    const homePath = `/homes/${user.id}`;
    if (existsSync(homePath)) {
      const rcloneDir = `${homePath}/.config/rclone`;
      mkdirSync(rcloneDir, { recursive: true });
      writeFileSync(
        `${rcloneDir}/rclone.conf`,
        `[b2]\ntype = b2\naccount = ${parsed.b2KeyId}\nkey = ${parsed.b2AppKey}\n`,
        { mode: 0o600 },
      );
      chownSync(`${rcloneDir}/rclone.conf`, 101000, 101000);
    }

    return c.json({ ok: true });
  });

  app.delete("/backup", (c) => {
    const user = c.get("user");

    db.update(schema.userCredentials)
      .set({ backupConfig: null, updatedAt: new Date() })
      .where(eq(schema.userCredentials.userId, user.id))
      .run();

    return c.json({ ok: true });
  });

  // --- Backup Operations ---

  app.get("/backup/status", async (c) => {
    const user = c.get("user");
    const config = getBackupConfig(user.id);
    if (!config) return c.json({ error: "Backup not configured" }, 400);

    const username = getUsername(user.id);
    let confPath: string;
    try {
      confPath = writeRcloneConfig(user.id, config);
    } catch {
      return c.json({ error: "Stored backup config is invalid" }, 400);
    }
    const bucket = `b2:${config.b2Bucket}/${username}`;

    try {
      const output = await rcloneExec(confPath, ["size", bucket, "--json"], 30_000);
      const size = JSON.parse(output) as { count: number; bytes: number };
      return c.json({ count: size.count, bytes: size.bytes });
    } catch {
      return c.json({ count: 0, bytes: 0 });
    }
  });

  app.get("/backup/files", async (c) => {
    const user = c.get("user");
    const config = getBackupConfig(user.id);
    if (!config) return c.json({ error: "Backup not configured" }, 400);

    const username = getUsername(user.id);
    let confPath: string;
    try {
      confPath = writeRcloneConfig(user.id, config);
    } catch {
      return c.json({ error: "Stored backup config is invalid" }, 400);
    }
    const bucket = `b2:${config.b2Bucket}/${username}`;

    try {
      const output = await rcloneExec(
        confPath,
        ["lsjson", bucket, "--recursive", "--no-modtime", "--no-mimetype"],
        30_000,
      );
      const files = JSON.parse(output) as { Path: string; Size: number; IsDir: boolean }[];
      // Return top-level entries only (dirs + files at root)
      const topLevel = files
        .filter((f) => !f.Path.includes("/") || f.IsDir)
        .filter((f) => !f.IsDir || !f.Path.includes("/"))
        .slice(0, 100);
      return c.json(topLevel);
    } catch {
      return c.json([]);
    }
  });

  app.post("/backup/save", async (c) => {
    const user = c.get("user");
    const config = getBackupConfig(user.id);
    if (!config) return c.json({ error: "Backup not configured" }, 400);

    const homePath = `/homes/${user.id}`;
    if (!existsSync(homePath)) {
      return c.json({ error: "No home directory found" }, 400);
    }

    const username = getUsername(user.id);
    let confPath: string;
    try {
      confPath = writeRcloneConfig(user.id, config);
    } catch {
      return c.json({ error: "Stored backup config is invalid" }, 400);
    }
    const bucket = `b2:${config.b2Bucket}/${username}`;

    const runId = startBackupRun(user.id, "save", null);
    try {
      // Drop -q (log level ERROR) — it silences rclone errors in some
      // failure modes, leaving us with "Command failed: ..." and no reason.
      // `--stats=0` suppresses periodic progress output, so stderr stays
      // small and any error rclone emits goes straight to the caught err.
      await rcloneExec(
        confPath,
        [
          "sync", homePath, bucket,
          "--exclude", ".cache/**",
          "--exclude", "**/node_modules/**",
          "--exclude", ".local/**",
          "--stats=0",
        ],
        300_000,
      );
      const size = await safeRcloneSize(confPath, bucket);
      finishBackupRun(runId, "success", {
        bytes: size?.bytes ?? null,
        fileCount: size?.count ?? null,
      });
      return c.json({ ok: true, runId });
    } catch (err) {
      const msg = extractExecError(err, "Backup failed");
      finishBackupRun(runId, "failed", { error: msg });
      console.error(`[backup] save failed for ${user.id}: ${msg}`);
      return c.json({ error: msg }, 500);
    }
  });

  app.post("/backup/restore", async (c) => {
    const user = c.get("user");
    const config = getBackupConfig(user.id);
    if (!config) return c.json({ error: "Backup not configured" }, 400);

    // Optional { snapshotAt } — ISO timestamp. When present, rclone uses
    // `--b2-versions-at` to pull file versions as they existed at that moment.
    // This only works if B2 has preserved those versions (bucket-level setting).
    let snapshotAt: string | null = null;
    if (c.req.header("content-length") && c.req.header("content-length") !== "0") {
      try {
        const body = await c.req.json<{ snapshotAt?: string }>();
        if (body.snapshotAt) {
          if (!ISO_TIMESTAMP_RE.test(body.snapshotAt)) {
            return c.json({ error: "snapshotAt must be an ISO 8601 timestamp" }, 400);
          }
          snapshotAt = body.snapshotAt;
        }
      } catch {
        // No body — treat as latest restore.
      }
    }

    const homePath = `/homes/${user.id}`;
    if (!existsSync(homePath)) {
      mkdirSync(homePath, { recursive: true });
      chownSync(homePath, 101000, 101000);
    }

    const username = getUsername(user.id);
    let confPath: string;
    try {
      confPath = writeRcloneConfig(user.id, config);
    } catch {
      return c.json({ error: "Stored backup config is invalid" }, 400);
    }
    const bucket = `b2:${config.b2Bucket}/${username}`;

    const runId = startBackupRun(user.id, "restore", snapshotAt ? new Date(snapshotAt) : null);
    try {
      const args = ["copy", bucket, homePath, "--stats=0"];
      if (snapshotAt) args.push("--b2-versions-at", snapshotAt);
      await rcloneExec(confPath, args, 300_000);
      // Fix ownership after restore — async + argv-only, no shell, non-blocking.
      await execFileAsync("chown", ["-R", "101000:101000", homePath], { timeout: 30_000 });
      finishBackupRun(runId, "success");
      return c.json({ ok: true, runId });
    } catch (err) {
      const msg = extractExecError(err, "Restore failed");
      finishBackupRun(runId, "failed", { error: msg });
      console.error(`[backup] restore failed for ${user.id}: ${msg}`);
      return c.json({ error: msg }, 500);
    }
  });

  // Probe whether the B2 bucket retains old file versions — needed for
  // point-in-time restore. Reads lifecycle rules via `rclone backend lifecycle`.
  //
  // Only rules whose prefix covers this user's directory (`<username>/`) count.
  // Status mapping:
  //   enabled  — no applicable rule, or rule never deletes old versions
  //   limited  — rule deletes old versions after N days (> 1)
  //   disabled — rule deletes old versions within 1 day
  //   unknown  — rclone errored or returned something unparseable
  app.get("/backup/versioning", async (c) => {
    const user = c.get("user");
    const config = getBackupConfig(user.id);
    if (!config) return c.json({ error: "Backup not configured" }, 400);

    let confPath: string;
    try {
      confPath = writeRcloneConfig(user.id, config);
    } catch {
      return c.json({ error: "Stored backup config is invalid" }, 400);
    }

    const username = getUsername(user.id);
    const userPrefix = `${username}/`;

    try {
      const output = await rcloneExec(
        confPath,
        ["backend", "lifecycle", `b2:${config.b2Bucket}`],
        15_000,
      );
      const rules = JSON.parse(output) as Array<{
        fileNamePrefix?: string;
        daysFromHidingToDeleting?: number | null;
        daysFromUploadingToHiding?: number | null;
      }>;

      if (!Array.isArray(rules) || rules.length === 0) {
        return c.json({ status: "enabled", retentionDays: null, rules: [] });
      }

      // Filter rules that actually apply to this user's backup path. A rule
      // with an empty prefix matches everything; a rule with a prefix matches
      // only if that prefix is a parent of our path.
      const applicable = rules.filter((r) => {
        const p = r.fileNamePrefix ?? "";
        return p === "" || userPrefix.startsWith(p);
      });

      if (applicable.length === 0) {
        return c.json({ status: "enabled", retentionDays: null, rules });
      }

      let minDays: number | null = null;
      let hasUnlimited = false;
      for (const r of applicable) {
        if (r.daysFromHidingToDeleting == null) {
          hasUnlimited = true;
        } else if (minDays === null || r.daysFromHidingToDeleting < minDays) {
          minDays = r.daysFromHidingToDeleting;
        }
      }

      // If *every* applicable rule keeps versions forever, we're good.
      // A single fast-delete rule poisons it even if another rule says forever,
      // because B2 applies whichever rule matches each file.
      if (minDays === null && hasUnlimited) {
        return c.json({ status: "enabled", retentionDays: null, rules });
      }
      if (minDays !== null && minDays <= 1) {
        return c.json({ status: "disabled", retentionDays: minDays, rules });
      }
      return c.json({ status: "limited", retentionDays: minDays, rules });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.error(`[backup] versioning probe failed for ${user.id}: ${msg}`);
      return c.json({ status: "unknown" });
    }
  });

  // Returns recent backup runs for the current user, newest first. Capped at
  // 50 so the UI table stays manageable and the response small.
  app.get("/backup/runs", (c) => {
    const user = c.get("user");
    const rows = db
      .select()
      .from(schema.backupRuns)
      .where(eq(schema.backupRuns.userId, user.id))
      .orderBy(desc(schema.backupRuns.startedAt))
      .limit(50)
      .all();

    return c.json(
      rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        startedAt: r.startedAt.getTime(),
        endedAt: r.endedAt ? r.endedAt.getTime() : null,
        bytes: r.bytes,
        fileCount: r.fileCount,
        snapshotAt: r.snapshotAt ? r.snapshotAt.getTime() : null,
        error: r.error,
      })),
    );
  });

  return app;
}
