import { Hono } from "hono";
import type { AuthUser } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { Orchestrator } from "../services/agent-auth/orchestrator.js";
import { AGENT_TOOLS } from "../services/agent-auth/registry.js";
import { writeAudit } from "../services/agent-auth/audit.js";
import { getSecretStore } from "../services/secrets/index.js";
import type { SessionManager } from "../services/session-manager.js";

export function integrationsAgentsRoutes(sessions: SessionManager) {
  const app = new Hono<{ Variables: { user: AuthUser } }>();
  const store = getSecretStore();
  const orch = new Orchestrator({
    sessions: {
      createAuthHelper: (uid) => sessions.createAuthHelper(uid),
      destroy: (sid) => sessions.destroy(sid),
    },
    store,
    audit: (entry) => writeAudit(db, entry),
  });

  app.get("/", async (c) => {
    const user = c.get("user");
    const results = await Promise.all(
      AGENT_TOOLS.map(async (t) => {
        const s = await orch.status({ userId: user.id, toolId: t.id });
        return {
          id: t.id,
          displayName: t.displayName,
          status: s.status,
          ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}),
        };
      }),
    );
    return c.json({ tools: results });
  });

  return app;
}
