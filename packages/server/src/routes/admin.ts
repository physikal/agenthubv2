import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { hashSync } from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { SessionManager } from "../services/session-manager.js";
import type { AuthUser } from "../middleware/auth.js";

export function adminRoutes(sessionManager: SessionManager) {
  const app = new Hono<{ Variables: { user: AuthUser } }>();

  // --- Users ---

  app.get("/users", (c) => {
    const rows = db
      .select({
        id: schema.users.id,
        username: schema.users.username,
        displayName: schema.users.displayName,
        role: schema.users.role,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .all();
    return c.json(rows);
  });

  app.post("/users", async (c) => {
    const body = await c.req.json<{
      username: string;
      password: string;
      displayName?: string;
      role?: string;
    }>();

    if (!body.username?.trim() || !body.password?.trim()) {
      return c.json({ error: "Username and password required" }, 400);
    }
    if (body.username.length > 50) {
      return c.json({ error: "Username too long (max 50 chars)" }, 400);
    }
    if (body.password.length > 128) {
      return c.json({ error: "Password too long (max 128 chars)" }, 400);
    }

    const existing = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, body.username.trim()))
      .all();

    if (existing.length > 0) {
      return c.json({ error: "Username already taken" }, 409);
    }

    const id = randomUUID();
    const hash = hashSync(body.password, 12);
    const role = body.role === "admin" ? "admin" : "user";

    db.insert(schema.users)
      .values({
        id,
        username: body.username.trim(),
        passwordHash: hash,
        displayName: body.displayName?.trim() ?? body.username.trim(),
        role,
      })
      .run();

    return c.json(
      { id, username: body.username.trim(), role },
      201,
    );
  });

  app.patch("/users/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{
      password?: string;
      displayName?: string;
      role?: string;
    }>();

    const existing = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .all();
    if (existing.length === 0) {
      return c.json({ error: "User not found" }, 404);
    }

    const updates: Record<string, string> = {};
    if (body.password?.trim()) {
      if (body.password.length > 128) {
        return c.json({ error: "Password too long" }, 400);
      }
      updates["passwordHash"] = hashSync(body.password, 12);
    }
    if (body.displayName?.trim()) {
      updates["displayName"] = body.displayName.trim();
    }
    if (body.role === "admin" || body.role === "user") {
      updates["role"] = body.role;
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "No valid fields to update" }, 400);
    }

    db.update(schema.users)
      .set(updates)
      .where(eq(schema.users.id, id))
      .run();

    return c.json({ ok: true });
  });

  app.delete("/users/:id", (c) => {
    const id = c.req.param("id");

    // Prevent deleting yourself
    const currentUser = c.get("user");
    if (currentUser?.id === id) {
      return c.json({ error: "Cannot delete your own account" }, 400);
    }

    db.delete(schema.users).where(eq(schema.users.id, id)).run();
    return c.json({ ok: true });
  });

  // --- Sessions (all users) ---

  app.get("/sessions", (c) => {
    const allSessions = sessionManager.listSessions();
    return c.json(allSessions);
  });

  app.post("/sessions/:id/end", async (c) => {
    const id = c.req.param("id");
    await sessionManager.endSession(id);
    return c.json({ ok: true });
  });

  return app;
}
