import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AuthUser } from "../middleware/auth.js";
import { runWorkspaceBackup, runWorkspaceRestore } from "../services/workspace-backup/runner.js";
import { listWorkspaceRuns } from "../services/workspace-backup/history.js";
import { loadB2Config } from "../services/install-backup/runner.js";

const HOST_BACKUP_DIR = process.env["AGENTHUB_WORKSPACE_BACKUP_DIR"] ?? "/data/workspace-backups";
const SAFE_FILE = /^workspace-[A-Za-z0-9_-]+\.tar\.zst$/;

export function userWorkspaceBackupRoutes() {
  const app = new Hono<{ Variables: { user: AuthUser } }>();

  app.get("/", (c) => c.json({ runs: listWorkspaceRuns(c.get("user").id, 50) }));

  app.post("/run", async (c) => {
    const user = c.get("user");
    return streamSSE(c, async (stream) => {
      const write = (event: string, data: string): void => {
        stream.writeSSE({ event, data }).catch(() => {});
      };
      try {
        const cfg = await loadB2Config().catch(() => null);
        const r = await runWorkspaceBackup({
          userId: user.id,
          userEmail: user.username ?? null,
          workspaceImageSha: process.env["WORKSPACE_IMAGE_SHA"] ?? null,
          trigger: "manual",
          b2: cfg,
          onLog: (l) => write("log", l),
        });
        write("done", JSON.stringify({ bundlePath: r.bundlePath, bytes: r.bytes }));
      } catch (err) {
        write("error", err instanceof Error ? err.message : "unknown");
      }
    });
  });

  app.get("/download/:filename", (c) => {
    const filename = c.req.param("filename");
    if (!SAFE_FILE.test(filename)) return c.json({ error: "bad filename" }, 400);
    const path = join(HOST_BACKUP_DIR, c.get("user").id, filename);
    if (!existsSync(path)) return c.json({ error: "not found" }, 404);
    const stat = statSync(path);
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": "application/zstd",
        "Content-Length": String(stat.size),
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  });

  app.post("/restore/run", async (c) => {
    if (c.req.header("Confirm-Restore") !== "yes-i-know-what-this-does") {
      return c.json({ error: "missing Confirm-Restore header" }, 403);
    }
    const user = c.get("user");
    const body = await c.req.json<{
      source: { kind: "b2-snapshot"; snapshot: "latest" | string } | { kind: "local"; filename: string };
      force?: boolean;
    }>();
    if (!body.source || (body.source.kind !== "b2-snapshot" && body.source.kind !== "local")) {
      return c.json({ error: "source must be { kind: 'b2-snapshot' | 'local', ... }" }, 400);
    }
    if (body.source.kind === "local" && !SAFE_FILE.test(body.source.filename)) {
      return c.json({ error: "bad filename" }, 400);
    }
    return streamSSE(c, async (stream) => {
      const write = (event: string, data: string): void => {
        stream.writeSSE({ event, data }).catch(() => {});
      };
      try {
        const cfg = await loadB2Config().catch(() => null);
        const input: Parameters<typeof runWorkspaceRestore>[0] = {
          userId: user.id,
          b2: cfg,
          force: body.force ?? false,
          onLog: (l) => write("log", l),
        };
        if (body.source.kind === "b2-snapshot") input.b2Snapshot = body.source.snapshot;
        else {
          input.localBundlePath = join(HOST_BACKUP_DIR, user.id, body.source.filename);
        }
        const r = await runWorkspaceRestore(input);
        write("done", JSON.stringify(r));
      } catch (err) {
        write("error", err instanceof Error ? err.message : "unknown");
      }
    });
  });

  return app;
}
