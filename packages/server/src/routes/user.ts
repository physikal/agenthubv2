import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { AuthUser } from "../middleware/auth.js";
import {
  assertSafeB2Credential,
  assertSafeBucketName,
  assertSafeUserId,
} from "../services/shell-safety.js";
import {
  getSecretStore,
  SecretStoreNotConfiguredError,
} from "../services/secrets/index.js";
import type {
  BackupParams,
  BackupResult,
  SessionManager,
} from "../services/session-manager.js";

// RFC3339-ish: 2024-01-15T12:30:00.000Z or with +hh:mm offset.
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

interface BackupConfig {
  b2KeyId: string;
  b2AppKey: string;
  b2Bucket: string;
}

const BACKUP_SECRET_NAMES = ["b2KeyId", "b2AppKey", "b2Bucket"] as const;
function backupPath(userId: string): string {
  return `/users/${userId}/b2`;
}

function validateBackupConfig(config: BackupConfig): void {
  assertSafeB2Credential(config.b2KeyId, "b2KeyId");
  assertSafeB2Credential(config.b2AppKey, "b2AppKey");
  assertSafeBucketName(config.b2Bucket);
}

function maskKey(key: string): string {
  if (key.length <= 4) return "•".repeat(key.length);
  return "•".repeat(key.length - 4) + key.slice(-4);
}

async function getBackupConfig(userId: string): Promise<BackupConfig | null> {
  const store = getSecretStore();
  if (!store.configured) return null;
  const secrets = await store.getAllSecrets(backupPath(userId));
  const { b2KeyId, b2AppKey, b2Bucket } = secrets;
  if (!b2KeyId || !b2AppKey || !b2Bucket) return null;
  return { b2KeyId, b2AppKey, b2Bucket };
}

async function setBackupConfig(userId: string, cfg: BackupConfig): Promise<void> {
  const store = getSecretStore();
  await store.setSecrets(backupPath(userId), { ...cfg });
}

async function deleteBackupConfig(userId: string): Promise<void> {
  const store = getSecretStore();
  if (!store.configured) return;
  for (const name of BACKUP_SECRET_NAMES) {
    await store.deleteSecret(backupPath(userId), name);
  }
}

function getUsername(userId: string): string {
  assertSafeUserId(userId);
  const rows = db
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .all();
  return rows[0]?.username ?? userId;
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

function toAgentParams(
  cfg: BackupConfig,
  username: string,
  snapshotAt?: string,
): BackupParams {
  const params: BackupParams = {
    b2KeyId: cfg.b2KeyId,
    b2AppKey: cfg.b2AppKey,
    b2Bucket: cfg.b2Bucket,
    subdir: username,
  };
  if (snapshotAt) params.snapshotAt = snapshotAt;
  return params;
}

export function userRoutes(sessionManager: SessionManager) {
  const app = new Hono<{ Variables: { user: AuthUser } }>();

  // --- Backup Config ---

  app.get("/backup", async (c) => {
    const user = c.get("user");
    const store = getSecretStore();
    if (!store.configured) {
      return c.json({ configured: false, storeReady: false });
    }
    const config = await getBackupConfig(user.id);
    if (!config) return c.json({ configured: false, storeReady: true });

    return c.json({
      configured: true,
      storeReady: true,
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

    try {
      validateBackupConfig(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid config";
      return c.json({ error: msg }, 400);
    }

    try {
      await setBackupConfig(user.id, parsed);
    } catch (err) {
      if (err instanceof SecretStoreNotConfiguredError) {
        return c.json({ error: err.message }, 503);
      }
      throw err;
    }

    return c.json({ ok: true });
  });

  app.delete("/backup", async (c) => {
    const user = c.get("user");
    try {
      await deleteBackupConfig(user.id);
    } catch (err) {
      if (err instanceof SecretStoreNotConfiguredError) {
        return c.json({ error: err.message }, 503);
      }
      throw err;
    }
    return c.json({ ok: true });
  });

  // --- Backup Operations (all delegated to the agent daemon inside the workspace) ---

  app.get("/backup/status", async (c) => {
    const user = c.get("user");
    const config = await getBackupConfig(user.id);
    if (!config) return c.json({ error: "Backup not configured" }, 400);

    try {
      const result = await sessionManager.backupViaAgent(
        user.id,
        "size",
        toAgentParams(config, getUsername(user.id)),
      );
      if (!result.ok) {
        return c.json({ count: 0, bytes: 0, error: result.error });
      }
      return c.json({ count: result.fileCount ?? 0, bytes: result.bytes ?? 0 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      return c.json({ count: 0, bytes: 0, error: msg });
    }
  });

  app.post("/backup/save", async (c) => {
    const user = c.get("user");
    const config = await getBackupConfig(user.id);
    if (!config) return c.json({ error: "Backup not configured" }, 400);

    const runId = startBackupRun(user.id, "save", null);
    let result: BackupResult;
    try {
      result = await sessionManager.backupViaAgent(
        user.id,
        "save",
        toAgentParams(config, getUsername(user.id)),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      finishBackupRun(runId, "failed", { error: msg });
      return c.json({ error: msg }, 500);
    }

    if (!result.ok) {
      finishBackupRun(runId, "failed", { error: result.error ?? "unknown error" });
      return c.json({ error: result.error ?? "Backup failed" }, 500);
    }
    finishBackupRun(runId, "success", {
      bytes: result.bytes ?? null,
      fileCount: result.fileCount ?? null,
    });
    return c.json({ ok: true, runId, bytes: result.bytes, fileCount: result.fileCount });
  });

  app.post("/backup/restore", async (c) => {
    const user = c.get("user");
    const config = await getBackupConfig(user.id);
    if (!config) return c.json({ error: "Backup not configured" }, 400);

    // Optional { snapshotAt }
    let snapshotAt: string | undefined;
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
        // no body — treat as latest restore
      }
    }

    const runId = startBackupRun(
      user.id,
      "restore",
      snapshotAt ? new Date(snapshotAt) : null,
    );
    let result: BackupResult;
    try {
      result = await sessionManager.backupViaAgent(
        user.id,
        "restore",
        toAgentParams(config, getUsername(user.id), snapshotAt),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      finishBackupRun(runId, "failed", { error: msg });
      return c.json({ error: msg }, 500);
    }

    if (!result.ok) {
      finishBackupRun(runId, "failed", { error: result.error ?? "unknown error" });
      return c.json({ error: result.error ?? "Restore failed" }, 500);
    }
    finishBackupRun(runId, "success");
    return c.json({ ok: true, runId });
  });

  // Backup run history
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
