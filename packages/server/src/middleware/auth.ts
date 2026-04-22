import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";

export interface AuthUser {
  id: string;
  username: string;
  role: string;
}

export const authMiddleware = createMiddleware<{
  Variables: { user: AuthUser };
}>(async (c, next) => {
  const token = getCookie(c, "session_token");
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const rows = db
    .select({
      token: schema.sessionTokens.token,
      userId: schema.sessionTokens.userId,
      expiresAt: schema.sessionTokens.expiresAt,
      username: schema.users.username,
      role: schema.users.role,
    })
    .from(schema.sessionTokens)
    .innerJoin(schema.users, eq(schema.sessionTokens.userId, schema.users.id))
    .where(eq(schema.sessionTokens.token, token))
    .all();

  const row = rows[0];
  if (!row) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    db.delete(schema.sessionTokens)
      .where(eq(schema.sessionTokens.token, token))
      .run();
    return c.json({ error: "Session expired" }, 401);
  }

  c.set("user", { id: row.userId, username: row.username, role: row.role });
  await next();
});

export const adminMiddleware = createMiddleware<{
  Variables: { user: AuthUser };
}>(async (c, next) => {
  const user = c.get("user");
  if (user?.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
});

/**
 * Middleware for agent-authenticated requests (MCP server inside workspace).
 *
 *   Authorization: AgentToken <per-session-token>
 *   — Token is the value of `sessions.agentToken` for this workspace. Bound
 *     to one session; cross-session impersonation is impossible.
 */
export const agentAuthMiddleware = createMiddleware<{
  Variables: { user: AuthUser };
}>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("AgentToken ")) {
    return c.json({ error: "Agent auth required" }, 401);
  }

  const token = authHeader.slice("AgentToken ".length);
  if (!token) {
    return c.json({ error: "Empty agent token" }, 401);
  }

  const rows = db
    .select({
      userId: schema.sessions.userId,
      username: schema.users.username,
      role: schema.users.role,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(eq(schema.sessions.agentToken, token))
    .all();

  const sess = rows[0];
  if (!sess?.userId) {
    return c.json({ error: "Invalid agent token" }, 401);
  }

  c.set("user", { id: sess.userId, username: sess.username, role: sess.role });
  await next();
});

/** Look up a session token from a raw cookie header string (for WebSocket upgrades). */
export function authenticateToken(cookieHeader: string | undefined): AuthUser | null {
  if (!cookieHeader) return null;

  const match = /(?:^|;\s*)session_token=([^\s;]+)/.exec(cookieHeader);
  const token = match?.[1];
  if (!token) return null;

  const rows = db
    .select({
      userId: schema.sessionTokens.userId,
      expiresAt: schema.sessionTokens.expiresAt,
      username: schema.users.username,
      role: schema.users.role,
    })
    .from(schema.sessionTokens)
    .innerJoin(schema.users, eq(schema.sessionTokens.userId, schema.users.id))
    .where(eq(schema.sessionTokens.token, token))
    .all();

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

  return { id: row.userId, username: row.username, role: row.role };
}
