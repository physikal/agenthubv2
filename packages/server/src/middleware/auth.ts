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
 * Middleware for agent-authenticated requests (MCP server inside LXC).
 *
 * Primary path:
 *   Authorization: AgentToken <per-session-token>
 *   — Token is the value of `sessions.agentToken` for the claimed container.
 *     Bound to one session; cross-session impersonation is impossible.
 *
 * Legacy path (transitional — will be removed):
 *   Authorization: AgentToken <shared AGENT_AUTH_TOKEN>
 *   X-Vmid: <vmid>
 *   — Any container that holds the shared token could forge X-Vmid and
 *     impersonate any session's user. Logged as a deprecation warning.
 *
 * Remove the legacy path once all pool containers have been cycled at
 * least once (default TTL: 7 days) and logs confirm no legacy traffic.
 */
let warnedLegacyAuth = false;

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

  // --- Primary path: per-session agentToken ---
  const perSession = db
    .select({
      userId: schema.sessions.userId,
      username: schema.users.username,
      role: schema.users.role,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(eq(schema.sessions.agentToken, token))
    .all();

  const sess = perSession[0];
  if (sess?.userId) {
    c.set("user", { id: sess.userId, username: sess.username, role: sess.role });
    await next();
    return;
  }

  // --- Legacy path: shared AGENT_AUTH_TOKEN + X-Vmid ---
  const sharedToken = process.env["AGENT_AUTH_TOKEN"];
  const vmidHeader = c.req.header("X-Vmid");
  if (sharedToken && token === sharedToken && vmidHeader) {
    const vmid = parseInt(vmidHeader, 10);
    if (Number.isNaN(vmid)) {
      return c.json({ error: "Invalid VMID" }, 400);
    }

    const byVmid = db
      .select({
        userId: schema.sessions.userId,
        username: schema.users.username,
        role: schema.users.role,
      })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
      .where(eq(schema.sessions.lxcVmid, vmid))
      .all();

    const legacy = byVmid[0];
    if (legacy?.userId) {
      if (!warnedLegacyAuth) {
        console.warn(
          "[auth] agent using legacy shared-token + X-Vmid auth. " +
            "Per-session tokens are available; legacy path will be removed.",
        );
        warnedLegacyAuth = true;
      }
      c.set("user", { id: legacy.userId, username: legacy.username, role: legacy.role });
      await next();
      return;
    }
  }

  return c.json({ error: "Invalid agent token" }, 401);
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
