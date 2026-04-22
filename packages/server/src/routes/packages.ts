import { Hono } from "hono";
import type { AuthUser } from "../middleware/auth.js";
import type { PackageManager } from "../services/packages/manager.js";
import { listCatalog } from "../services/packages/catalog.js";

/**
 * Packages page routes. The agent inside the user's active workspace is
 * responsible for the actual install/remove — these routes just kick off
 * the op and track state in the `user_packages` table.
 */
export function packagesRoutes(manager: PackageManager) {
  const app = new Hono<{ Variables: { user: AuthUser } }>();

  // Catalog shape without user state. Public to authed users.
  app.get("/catalog", (c) => {
    return c.json(
      listCatalog().map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        homepage: m.homepage,
        isBuiltin: Boolean(m.isBuiltin),
      })),
    );
  });

  // Catalog merged with the user's install status.
  app.get("/", (c) => {
    const user = c.get("user");
    return c.json(manager.listForUser(user.id));
  });

  app.get("/:id/status", (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const entry = manager.getStatus(user.id, id);
    if (!entry) return c.json({ error: "Not found" }, 404);
    return c.json(entry);
  });

  app.post("/:id/install", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const result = await manager.startInstall(user.id, id);
    if (result.status === "conflict") {
      return c.json({ error: result.reason }, 409);
    }
    return c.json({ state: result.state }, 202);
  });

  app.post("/:id/remove", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const result = await manager.startRemove(user.id, id);
    if (result.status === "not-found") {
      return c.json({ error: "Package is not installed" }, 404);
    }
    if (result.status === "conflict") {
      return c.json({ error: result.reason }, 409);
    }
    return c.json({ state: result.state }, 202);
  });

  return app;
}
