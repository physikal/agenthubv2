import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import {
  runWorkspaceBackup,
  runWorkspaceRestore,
} from "../services/workspace-backup/runner.js";
import { listWorkspaceRuns } from "../services/workspace-backup/history.js";
import { loadB2Config } from "../services/install-backup/runner.js";

const HOST_BACKUP_DIR =
  process.env["AGENTHUB_WORKSPACE_BACKUP_DIR"] ?? "/data/workspace-backups";
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_FILE = /^workspace-.+\.tar\.zst$/;

function lookupUsername(userId: string): string | null {
  try {
    const found = db
      .select({ username: schema.users.username })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .all();
    return found[0]?.username ?? null;
  } catch {
    return null;
  }
}

export function adminWorkspaceBackupRoutes() {
  const app = new Hono();

  app.get("/runs", (c) => {
    const userId = c.req.query("userId") ?? null;
    return c.json({ runs: listWorkspaceRuns(userId, 50) });
  });

  app.post("/run", async (c) => {
    const body = await c.req.json<{
      userId?: string;
      all?: boolean;
      noB2?: boolean;
      note?: string;
    }>();
    if (!body.all && !body.userId) {
      return c.json({ error: "userId or all required" }, 400);
    }

    return streamSSE(c, async (stream) => {
      const write = (event: string, data: string): void => {
        stream.writeSSE({ event, data }).catch(() => {});
      };
      try {
        const cfg = body.noB2 ? null : await loadB2Config().catch(() => null);
        let users: { id: string; username: string | null }[];
        if (body.all) {
          users = db
            .select({ id: schema.users.id, username: schema.users.username })
            .from(schema.users)
            .all();
        } else {
          const userId = body.userId as string;
          // An explicit userId always runs. The username lookup is best-effort
          // metadata (used only for log lines), never a precondition — so a
          // missing row OR a failing query falls back to username:null and
          // still runs the backup for the requested userId.
          users = [{ id: userId, username: lookupUsername(userId) }];
        }
        if (users.length === 0) {
          write("error", "no matching user");
          return;
        }

        for (const u of users) {
          write("log", `[ws-backup] === ${u.username ?? u.id} (${u.id}) ===`);
          try {
            const r = await runWorkspaceBackup({
              userId: u.id,
              userEmail: u.username,
              workspaceImageSha: process.env["WORKSPACE_IMAGE_SHA"] ?? null,
              trigger: "manual",
              b2: cfg,
              ...(body.note ? { note: body.note } : {}),
              onLog: (l) => write("log", l),
            });
            write("log", `[ws-backup] ok: ${r.bundlePath} (${r.bytes} bytes)`);
          } catch (err) {
            write(
              "log",
              `[ws-backup] FAILED ${u.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        write("done", JSON.stringify({ count: users.length }));
      } catch (err) {
        write("error", err instanceof Error ? err.message : "unknown");
      }
    });
  });

  app.get("/download/:userId/:filename", (c) => {
    const userId = c.req.param("userId");
    const filename = c.req.param("filename");
    if (!SAFE_ID.test(userId) || !SAFE_FILE.test(filename)) {
      return c.json({ error: "bad path" }, 400);
    }
    const path = join(HOST_BACKUP_DIR, userId, filename);
    if (!existsSync(path)) return c.json({ error: "not found" }, 404);
    const stat = statSync(path);
    return new Response(
      Readable.toWeb(createReadStream(path)) as ReadableStream,
      {
        status: 200,
        headers: {
          "Content-Type": "application/zstd",
          "Content-Length": String(stat.size),
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      },
    );
  });

  app.post("/restore/run", async (c) => {
    if (c.req.header("Confirm-Restore") !== "yes-i-know-what-this-does") {
      return c.json({ error: "missing Confirm-Restore header" }, 403);
    }
    const body = await c.req.json<{
      userId: string;
      source:
        | { kind: "b2-snapshot"; snapshot: "latest" | string }
        | { kind: "local"; filename: string };
      force?: boolean;
    }>();
    if (!body.userId || !SAFE_ID.test(body.userId)) {
      return c.json({ error: "userId required" }, 400);
    }
    if (!body.source || (body.source.kind !== "b2-snapshot" && body.source.kind !== "local")) {
      return c.json({ error: "source must be { kind: 'b2-snapshot' | 'local', ... }" }, 400);
    }

    return streamSSE(c, async (stream) => {
      const write = (event: string, data: string): void => {
        stream.writeSSE({ event, data }).catch(() => {});
      };
      try {
        const cfg = await loadB2Config().catch(() => null);
        const restoreInput: Parameters<typeof runWorkspaceRestore>[0] = {
          userId: body.userId,
          b2: cfg,
          force: body.force ?? false,
          onLog: (l) => write("log", l),
        };
        if (body.source.kind === "b2-snapshot") {
          restoreInput.b2Snapshot = body.source.snapshot;
        } else {
          if (!SAFE_FILE.test(body.source.filename)) {
            write("error", "bad filename");
            return;
          }
          restoreInput.localBundlePath = join(
            HOST_BACKUP_DIR,
            body.userId,
            body.source.filename,
          );
        }
        const r = await runWorkspaceRestore(restoreInput);
        write("done", JSON.stringify(r));
      } catch (err) {
        write("error", err instanceof Error ? err.message : "unknown");
      }
    });
  });

  return app;
}
