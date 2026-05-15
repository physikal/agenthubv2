import { Hono } from "hono";
import type { AuthUser } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { listAudit } from "../services/agent-auth/audit.js";
import { AGENT_TOOLS } from "../services/agent-auth/registry.js";

export function adminAgentAuthRoutes() {
  const app = new Hono<{ Variables: { user: AuthUser } }>();

  app.get("/audit", async (c) => {
    const userId = c.req.query("userId");
    const limitStr = c.req.query("limit") ?? "100";
    const limit = Math.min(parseInt(limitStr, 10) || 100, 500);
    if (!userId) return c.json({ error: "userId required" }, 400);
    const rows = await listAudit(db, { userId, limit });
    return c.json({ rows });
  });

  app.get("/registry", (c) => {
    return c.json({
      tools: AGENT_TOOLS.map((t) => ({
        id: t.id,
        displayName: t.displayName,
        loginCommand: t.loginCommand,
        credentialPaths: t.credentialPaths,
      })),
    });
  });

  return app;
}
