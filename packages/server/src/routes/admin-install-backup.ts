import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createReadStream, existsSync, statSync } from "fs";
import { Readable } from "stream";
import { db, schema } from "../db/index.js";
import { eq, desc, sql } from "drizzle-orm";
import {
  runBackup,
  loadB2Config,
  saveB2AppKey,
} from "../services/install-backup/runner.js";
import {
  resolveSource,
  extractAndValidate,
  buildConflictReport,
  applyRestore,
} from "../services/install-backup/restorer.js";
import { b2List } from "../services/install-backup/b2-client.js";
import type { RestoreSource } from "../services/install-backup/types.js";
import type { AuthUser } from "../middleware/auth.js";

const MASK = "••••••••";

export function installBackupRoutes() {
  const app = new Hono<{ Variables: { user: AuthUser } }>();

  // GET /api/admin/install-backup — current config + last run summary
  app.get("/", async (c) => {
    const rows = await db
      .select()
      .from(schema.installBackupConfig)
      .where(eq(schema.installBackupConfig.id, 1));
    const row = rows[0];

    const lastRunRows = await db
      .select()
      .from(schema.installBackupRuns)
      .orderBy(desc(schema.installBackupRuns.startedAt))
      .limit(1);
    const lastRun = lastRunRows[0];

    return c.json({
      b2: row
        ? {
            keyId: row.b2KeyId ?? "",
            appKey: row.b2KeyId ? MASK : "",
            bucket: row.b2Bucket ?? "",
            pathPrefix: row.b2PathPrefix ?? "installs/",
            retentionKeepLast: row.retentionKeepLast ?? 10,
          }
        : null,
      lastRun: lastRun
        ? {
            id: lastRun.id,
            startedAt: lastRun.startedAt,
            finishedAt: lastRun.finishedAt,
            status: lastRun.status,
            bytes: lastRun.bytes,
            b2Path: lastRun.b2Path,
            localPath: lastRun.localPath,
            trigger: lastRun.trigger,
          }
        : null,
    });
  });

  // PUT /api/admin/install-backup — save backup config (B2 or S3-compatible)
  app.put("/", async (c) => {
    const body = await c.req.json<{
      b2KeyId: string;
      b2AppKey?: string;
      b2Bucket: string;
      b2PathPrefix?: string;
      retentionKeepLast?: number;
      backend?: "b2" | "s3";
      endpoint?: string;
      region?: string;
    }>();

    if (body.b2AppKey && body.b2AppKey !== MASK) {
      await saveB2AppKey(body.b2AppKey);
    }

    // Normalize: null backend → "b2"; explicit "b2" → null in storage so
    // rows from before the migration stay unchanged.
    const backend = body.backend === "s3" ? "s3" : null;
    const endpoint = backend === "s3" ? (body.endpoint ?? null) : null;
    const region = backend === "s3" ? (body.region ?? null) : null;

    const now = new Date().toISOString();
    const existing = await db
      .select()
      .from(schema.installBackupConfig)
      .where(eq(schema.installBackupConfig.id, 1));

    if (existing.length === 0) {
      await db.insert(schema.installBackupConfig).values({
        id: 1,
        b2KeyId: body.b2KeyId,
        b2Bucket: body.b2Bucket,
        b2PathPrefix: body.b2PathPrefix ?? "installs/",
        retentionKeepLast: body.retentionKeepLast ?? 10,
        backend,
        endpoint,
        region,
        updatedAt: now,
      });
    } else {
      await db
        .update(schema.installBackupConfig)
        .set({
          b2KeyId: body.b2KeyId,
          b2Bucket: body.b2Bucket,
          b2PathPrefix: body.b2PathPrefix ?? "installs/",
          retentionKeepLast: body.retentionKeepLast ?? 10,
          backend,
          endpoint,
          region,
          updatedAt: now,
        })
        .where(eq(schema.installBackupConfig.id, 1));
    }

    return c.json({ ok: true });
  });

  // POST /api/admin/install-backup/test — verify B2 connectivity
  app.post("/test", async (c) => {
    const cfg = await loadB2Config();
    if (!cfg) return c.json({ ok: false, error: "B2 not configured" }, 400);
    try {
      const files = await b2List(cfg);
      return c.json({ ok: true, fileCount: files.length });
    } catch (err) {
      return c.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  // POST /api/admin/install-backup/run — trigger backup, stream progress as SSE
  app.post("/run", async (c) => {
    const body = await c.req.json<{ noB2?: boolean; note?: string }>();
    return streamSSE(c, async (stream) => {
      const safeWrite = (ev: { event: string; data: string }): void => {
        stream.writeSSE(ev).catch(() => {});
      };
      try {
        const result = await runBackup({
          trigger: "manual",
          ...(body.note ? { note: body.note } : {}),
          ...(body.noB2 ? { noB2: true } : {}),
          onLog: (line) => safeWrite({ event: "log", data: line }),
        });
        safeWrite({ event: "done", data: JSON.stringify(result) });
      } catch (err) {
        safeWrite({
          event: "error",
          data: err instanceof Error ? err.message : "unknown",
        });
      }
    });
  });

  // GET /api/admin/install-backup/runs — last 50 run records
  app.get("/runs", async (c) => {
    const rows = await db
      .select()
      .from(schema.installBackupRuns)
      .orderBy(desc(schema.installBackupRuns.startedAt))
      .limit(50);
    return c.json({ runs: rows });
  });

  // GET /api/admin/install-backup/runs/:id/download — download local bundle
  app.get("/runs/:id/download", async (c) => {
    const id = c.req.param("id");
    const rows = await db
      .select()
      .from(schema.installBackupRuns)
      .where(eq(schema.installBackupRuns.id, id));

    if (rows.length === 0 || !rows[0]?.localPath) {
      return c.json({ error: "not found or no local copy" }, 404);
    }

    const localPath = rows[0].localPath;
    if (!existsSync(localPath)) {
      return c.json({ error: "local file missing" }, 404);
    }

    const stat = statSync(localPath);
    const filename = localPath.split("/").pop() ?? "bundle.tar.gz";

    return new Response(
      Readable.toWeb(createReadStream(localPath)) as ReadableStream,
      {
        status: 200,
        headers: {
          "Content-Type": "application/gzip",
          "Content-Length": String(stat.size),
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      },
    );
  });

  // POST /api/admin/install-backup/restore/validate — dry-run conflict check
  app.post("/restore/validate", async (c) => {
    const body = await c.req.json<{ source: RestoreSource }>();
    const cfg = await loadB2Config();

    try {
      const localPath = await resolveSource(body.source, cfg);
      const bundle = await extractAndValidate(localPath);

      const userCountResult = await db
        .select({ c: sql<number>`count(*)` })
        .from(schema.users);
      const activeSessionCountResult = await db
        .select({ c: sql<number>`count(*)` })
        .from(schema.sessions)
        .where(sql`status NOT IN ('destroyed', 'failed')`);

      // secretCount: pass 0 — no cheap Infisical-side count available.
      // The encryption-key-mismatch conflict only fires when secretCount > 0,
      // so this is conservatively safe (no false positives).
      const report = buildConflictReport(bundle, {
        b2Config: cfg,
        userCount: Number(userCountResult[0]?.c ?? 0),
        secretCount: 0,
        activeSessionCount: Number(activeSessionCountResult[0]?.c ?? 0),
        currentEnvEncryptionKey: process.env["INFISICAL_ENCRYPTION_KEY"] ?? "",
      });

      return c.json({
        ok: report.ok,
        manifest: bundle.manifest,
        conflicts: report.conflicts,
      });
    } catch (err) {
      return c.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  // POST /api/admin/install-backup/restore/run — execute restore, stream progress as SSE
  // Requires Confirm-Restore: yes-i-know-what-this-does header.
  app.post("/restore/run", async (c) => {
    const confirm = c.req.header("Confirm-Restore");
    if (confirm !== "yes-i-know-what-this-does") {
      return c.json({ error: "missing Confirm-Restore header" }, 403);
    }

    const body = await c.req.json<{ source: RestoreSource; force?: boolean }>();

    return streamSSE(c, async (stream) => {
      const safeWrite = (ev: { event: string; data: string }): void => {
        stream.writeSSE(ev).catch(() => {});
      };

      try {
        const cfg = await loadB2Config();

        safeWrite({ event: "log", data: "[restore] resolving source..." });
        const localPath = await resolveSource(body.source, cfg);

        safeWrite({ event: "log", data: `[restore] extracting ${localPath}` });
        const bundle = await extractAndValidate(localPath);
        safeWrite({
          event: "log",
          data: `[restore] manifest: ${bundle.manifest.sourceDomain} @ ${bundle.manifest.createdAt}`,
        });

        if (!body.force) {
          const userCountResult = await db
            .select({ c: sql<number>`count(*)` })
            .from(schema.users);
          const activeSessionCountResult = await db
            .select({ c: sql<number>`count(*)` })
            .from(schema.sessions)
            .where(sql`status NOT IN ('destroyed', 'failed')`);

          const report = buildConflictReport(bundle, {
            b2Config: cfg,
            userCount: Number(userCountResult[0]?.c ?? 0),
            secretCount: 0, // same conservative-0 as validate endpoint
            activeSessionCount: Number(activeSessionCountResult[0]?.c ?? 0),
            currentEnvEncryptionKey: process.env["INFISICAL_ENCRYPTION_KEY"] ?? "",
          });

          if (!report.ok) {
            safeWrite({
              event: "error",
              data: `restore blocked by conflicts (use force=true to override): ${JSON.stringify(report.conflicts)}`,
            });
            return;
          }
        }

        const project =
          process.env["COMPOSE_PROJECT_NAME"] ?? "agenthub";
        await applyRestore(bundle, project, (line) =>
          safeWrite({ event: "log", data: line }),
        );
        safeWrite({ event: "done", data: "ok" });
      } catch (err) {
        safeWrite({
          event: "error",
          data: err instanceof Error ? err.message : "unknown",
        });
      }
    });
  });

  return app;
}
