import { Hono } from "hono";
import type { Session } from "../db/schema.js";
import type { SessionManager } from "../services/session-manager.js";
import type { AuthUser } from "../middleware/auth.js";

const MAX_NAME_LEN = 100;
const MAX_REPO_LEN = 2000;
const MAX_PROMPT_LEN = 5000;
const MAX_ACTIVE_SESSIONS = 3;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_UPLOAD_BASE64 = Math.ceil(MAX_UPLOAD_BYTES * 4 / 3);

const ACTIVE_STATUSES = new Set([
  "creating", "starting", "waiting_login", "active", "waiting_input", "idle",
]);

/** Strip internal infrastructure fields from session before returning to client. */
function sanitizeSession(s: Session) {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    statusDetail: s.statusDetail,
    userId: s.userId,
    repo: s.repo,
    prompt: s.prompt,
    createdAt: s.createdAt,
    endedAt: s.endedAt,
  };
}

export function sessionsRoutes(sessionManager: SessionManager) {
  const app = new Hono<{ Variables: { user: AuthUser } }>();

  app.get("/", (c) => {
    const user = c.get("user");
    const sessions = sessionManager.listSessionsForUser(user.id);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const active = sessions
      .filter((s) => ACTIVE_STATUSES.has(s.status))
      .map(sanitizeSession);

    const completed = sessions
      .filter(
        (s) =>
          ["completed", "failed"].includes(s.status) &&
          s.createdAt.getTime() >= todayStart.getTime(),
      )
      .map(sanitizeSession);

    const older = sessions
      .filter(
        (s) =>
          ["completed", "failed"].includes(s.status) &&
          s.createdAt.getTime() < todayStart.getTime(),
      )
      .map(sanitizeSession);

    return c.json({ active, completed, older });
  });

  app.get("/:id", (c) => {
    const user = c.get("user");
    const session = sessionManager.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (session.userId !== user.id && user.role !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }
    return c.json(sanitizeSession(session));
  });

  app.post("/", async (c) => {
    const user = c.get("user");
    const body = await c.req.json<{
      name: string;
      repo?: string;
      prompt?: string;
    }>();

    if (!body.name?.trim()) {
      return c.json({ error: "Session name is required" }, 400);
    }
    if (body.name.length > MAX_NAME_LEN) {
      return c.json({ error: `Session name too long (max ${String(MAX_NAME_LEN)} chars)` }, 400);
    }
    if (body.repo && body.repo.length > MAX_REPO_LEN) {
      return c.json({ error: "Repo URL too long" }, 400);
    }
    if (body.prompt && body.prompt.length > MAX_PROMPT_LEN) {
      return c.json({ error: "Prompt too long" }, 400);
    }

    // Per-user active session limit (admin exempt)
    if (user.role !== "admin") {
      const userSessions = sessionManager.listSessionsForUser(user.id);
      const activeCount = userSessions.filter((s) => ACTIVE_STATUSES.has(s.status)).length;
      if (activeCount >= MAX_ACTIVE_SESSIONS) {
        return c.json(
          { error: `Maximum ${String(MAX_ACTIVE_SESSIONS)} active sessions allowed` },
          429,
        );
      }
    }

    const session = await sessionManager.createSession({
      name: body.name.trim(),
      userId: user.id,
      repo: body.repo?.trim(),
      prompt: body.prompt?.trim(),
    });

    return c.json(sanitizeSession(session), 201);
  });

  app.post("/:id/start", (c) => {
    const user = c.get("user");
    const session = sessionManager.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (session.userId !== user.id && user.role !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }
    sessionManager.startTerminal(session.id);
    return c.json({ ok: true });
  });

  app.post("/:id/end", async (c) => {
    const user = c.get("user");
    const session = sessionManager.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (session.userId !== user.id && user.role !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }
    await sessionManager.endSession(session.id);
    return c.json({ ok: true });
  });

  app.post("/:id/upload", async (c) => {
    const user = c.get("user");
    const session = sessionManager.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (session.userId !== user.id && user.role !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }
    const body = await c.req.json<{ name: string; data: string }>();
    if (!body.name || !body.data) {
      return c.json({ error: "name and data required" }, 400);
    }
    if (body.data.length > MAX_UPLOAD_BASE64) {
      return c.json({ error: `Upload too large (max ${String(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)` }, 413);
    }
    const agent = sessionManager.getAgentConnection(session.id);
    if (agent) {
      agent.ws.send(JSON.stringify({ type: "upload", name: body.name, data: body.data }));
    }
    return c.json({ ok: true });
  });

  app.delete("/:id", async (c) => {
    const user = c.get("user");
    const session = sessionManager.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (session.userId !== user.id && user.role !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }
    await sessionManager.endSession(session.id);
    sessionManager.deleteSession(session.id);
    return c.json({ ok: true });
  });

  return app;
}
