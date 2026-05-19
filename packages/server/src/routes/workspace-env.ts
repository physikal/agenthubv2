import { Hono, type Context } from "hono";
import type { AuthUser } from "../middleware/auth.js";
import {
  listWorkspaceEnvNames,
  setWorkspaceEnv,
  deleteWorkspaceEnv,
  validateName,
} from "../services/secrets/workspace-env.js";
import { SecretStoreNotConfiguredError } from "../services/secrets/index.js";

/**
 * User-scoped CRUD for the per-user workspace env vars that AgentHub
 * injects into the workspace shell at session-active time. Lives under
 * `/api/user/workspace-env` (user auth via the same authMiddleware that
 * gates `/api/user/*`).
 *
 * GET    /                — list names (values never returned)
 * POST   /                — upsert {name, value}
 * DELETE /:name           — remove one
 *
 * Errors surface SecretStoreNotConfigured as 503 (consistent with
 * `/api/user/backup`).
 */
export function workspaceEnvRoutes(): Hono<{ Variables: { user: AuthUser } }> {
  const app = new Hono<{ Variables: { user: AuthUser } }>();

  app.get("/", async (c: Context<{ Variables: { user: AuthUser } }>) => {
    const user = c.get("user");
    try {
      const names = await listWorkspaceEnvNames(user.id);
      return c.json({ names });
    } catch (err) {
      if (err instanceof SecretStoreNotConfiguredError) {
        return c.json({ error: err.message }, 503);
      }
      throw err;
    }
  });

  app.post("/", async (c: Context<{ Variables: { user: AuthUser } }>) => {
    const user = c.get("user");
    const body = (await c.req.json()) as { name?: unknown; value?: unknown };
    if (typeof body.name !== "string" || typeof body.value !== "string") {
      return c.json({ error: "Body must be {name: string, value: string}" }, 400);
    }
    try {
      await setWorkspaceEnv(user.id, body.name, body.value);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof SecretStoreNotConfiguredError) {
        return c.json({ error: err.message }, 503);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

  app.delete("/:name", async (c: Context<{ Variables: { user: AuthUser } }>) => {
    const user = c.get("user");
    const name = c.req.param("name");
    // Surface bad names as 400 before touching the store. Defensive — the
    // service-level validateName also rejects, but a 400 here is clearer
    // than letting it bubble as a 500.
    const nameErr = validateName(name);
    if (nameErr && nameErr.reason !== "reserved") {
      return c.json({ error: nameErr.message }, 400);
    }
    try {
      await deleteWorkspaceEnv(user.id, name);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof SecretStoreNotConfiguredError) {
        return c.json({ error: err.message }, 503);
      }
      throw err;
    }
  });

  return app;
}
