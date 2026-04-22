import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
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
import {
  deleteInfraSecrets,
  resolveInfraConfig,
  storeInfraSecrets,
} from "../services/secrets/helpers.js";
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

// Legacy Infisical path used before B2 became a first-class row in
// infrastructure_configs. Still read as a fallback so users who configured
// B2 before the refactor don't lose access; wiped on next setBackupConfig.
const BACKUP_SECRET_NAMES = ["b2KeyId", "b2AppKey", "b2Bucket"] as const;
function legacyBackupPath(userId: string): string {
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

function getB2Row(userId: string) {
  return db
    .select()
    .from(schema.infrastructureConfigs)
    .where(
      and(
        eq(schema.infrastructureConfigs.userId, userId),
        eq(schema.infrastructureConfigs.provider, "b2"),
      ),
    )
    .get();
}

async function getBackupConfig(userId: string): Promise<BackupConfig | null> {
  // New path: one row in infrastructure_configs with provider='b2'.
  const row = getB2Row(userId);
  if (row) {
    const full = await resolveInfraConfig(
      userId,
      row.id,
      JSON.parse(row.config) as Record<string, unknown>,
    );
    const b2KeyId = typeof full["b2KeyId"] === "string" ? full["b2KeyId"] : "";
    const b2AppKey = typeof full["b2AppKey"] === "string" ? full["b2AppKey"] : "";
    const b2Bucket = typeof full["b2Bucket"] === "string" ? full["b2Bucket"] : "";
    if (b2KeyId && b2AppKey && b2Bucket) return { b2KeyId, b2AppKey, b2Bucket };
  }

  // Legacy path: secrets under /users/{u}/b2 from before the refactor.
  const store = getSecretStore();
  if (!store.configured) return null;
  const secrets = await store.getAllSecrets(legacyBackupPath(userId));
  const { b2KeyId, b2AppKey, b2Bucket } = secrets;
  if (!b2KeyId || !b2AppKey || !b2Bucket) return null;
  return { b2KeyId, b2AppKey, b2Bucket };
}

async function setBackupConfig(userId: string, cfg: BackupConfig): Promise<void> {
  const existing = getB2Row(userId);
  const now = new Date();
  const metadata = { b2KeyId: cfg.b2KeyId, b2Bucket: cfg.b2Bucket };
  const secrets = { b2AppKey: cfg.b2AppKey };

  if (existing) {
    await storeInfraSecrets(userId, existing.id, secrets);
    db.update(schema.infrastructureConfigs)
      .set({ config: JSON.stringify(metadata), status: "ready", updatedAt: now })
      .where(eq(schema.infrastructureConfigs.id, existing.id))
      .run();
  } else {
    const id = randomUUID();
    await storeInfraSecrets(userId, id, secrets);
    db.insert(schema.infrastructureConfigs)
      .values({
        id,
        userId,
        name: "backups",
        provider: "b2",
        config: JSON.stringify(metadata),
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  // Tidy up any legacy Infisical entries so they don't linger as a stale
  // fallback after migration. Best-effort — not fatal if missing.
  const store = getSecretStore();
  if (store.configured) {
    for (const name of BACKUP_SECRET_NAMES) {
      try {
        await store.deleteSecret(legacyBackupPath(userId), name);
      } catch {
        /* ignore */
      }
    }
  }
}

async function deleteBackupConfig(userId: string): Promise<void> {
  const row = getB2Row(userId);
  if (row) {
    try {
      await deleteInfraSecrets(userId, row.id);
    } catch {
      /* best-effort */
    }
    db.delete(schema.infrastructureConfigs)
      .where(eq(schema.infrastructureConfigs.id, row.id))
      .run();
  }

  // Also purge legacy secrets from before the refactor.
  const store = getSecretStore();
  if (store.configured) {
    for (const name of BACKUP_SECRET_NAMES) {
      try {
        await store.deleteSecret(legacyBackupPath(userId), name);
      } catch {
        /* ignore */
      }
    }
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
