import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { ImagesManager, type ApplyRequest } from "../services/images/manager.js";
import type { EnvOverrides } from "../services/images/env-overrides.js";
import type { RunningDigestResolver } from "../services/images/manager.js";
import { releaseUpdateLock, tryAcquireUpdateLock } from "../services/update-lock.js";

export interface AdminUpdatesDeps {
  readonly env: EnvOverrides;
  readonly runningDigest: RunningDigestResolver;
}

/**
 * Factory mirroring the pattern of `installBackupRoutes()` / `adminRoutes()`.
 * The caller mounts the returned app at `/api/admin/updates`; admin-gating
 * is applied globally via `app.use("/api/admin/*", adminMiddleware)` in
 * `index.ts`, so no per-route guard is needed here.
 */
export function adminUpdatesRoutes(deps: AdminUpdatesDeps): Hono {
  const app = new Hono();
  const mgr = new ImagesManager(deps.env, deps.runningDigest);

  app.get("/", async (c: Context) => {
    return c.json(await mgr.getUpdatesSummary());
  });

  app.post("/refresh", async (c: Context) => {
    // The poller is owned by index.ts; refresh is a hint, not an obligation.
    // The page will see fresh data on next GET.
    return c.json({ accepted: true }, 202);
  });

  app.post("/image", async (c: Context) => {
    const body = (await c.req.json()) as ApplyRequest;
    if (!tryAcquireUpdateLock("image")) {
      return c.json({ error: "another update is in progress" }, 409);
    }
    try {
      mgr.validateApply(body);
    } catch (err) {
      releaseUpdateLock();
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
    return streamSSE(c, async (stream) => {
      try {
        await mgr.applyImageUpdate(body, (e) => {
          if (e.kind === "phase") void stream.writeSSE({ event: "phase", data: e.phase });
          else if (e.kind === "log") void stream.writeSSE({ event: "log", data: e.line });
          else void stream.writeSSE({ event: "error", data: e.message });
        });
      } finally {
        releaseUpdateLock();
        await stream.writeSSE({ event: "end", data: "" });
      }
    });
  });

  return app;
}
