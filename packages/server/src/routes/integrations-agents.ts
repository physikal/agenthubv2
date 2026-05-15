import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
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

  app.post("/:toolId/connect", async (c) => {
    const user = c.get("user");
    const toolId = c.req.param("toolId");
    return streamSSE(c, async (stream) => {
      try {
        await orch.connect({
          userId: user.id,
          toolId,
          onEvent: (e) => {
            const data = (() => {
              if (e.phase === "awaiting-url" && e.url) {
                return { event: "url", payload: { url: e.url } };
              }
              if (e.phase === "captured") {
                return { event: "captured", payload: {} };
              }
              if (e.phase === "done") {
                return {
                  event: "done",
                  payload: e.expiresAt ? { ok: true, expiresAt: e.expiresAt } : { ok: true },
                };
              }
              if (e.phase === "error") {
                return { event: "error", payload: { message: e.error ?? "unknown" } };
              }
              return { event: "state", payload: { phase: e.phase } };
            })();
            void stream.writeSSE({ event: data.event, data: JSON.stringify(data.payload) });
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown";
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message }) });
      }
    });
  });

  app.post("/:toolId/disconnect", async (c) => {
    const user = c.get("user");
    const toolId = c.req.param("toolId");
    await orch.disconnect({ userId: user.id, toolId });
    return c.json({ ok: true });
  });

  app.post("/:toolId/refresh", async (c) => {
    const user = c.get("user");
    const toolId = c.req.param("toolId");
    return streamSSE(c, async (stream) => {
      try {
        await orch.connect({
          userId: user.id,
          toolId,
          onEvent: (e) => {
            const data = (() => {
              if (e.phase === "awaiting-url" && e.url) {
                return { event: "url", payload: { url: e.url } };
              }
              if (e.phase === "captured") {
                return { event: "captured", payload: {} };
              }
              if (e.phase === "done") {
                return {
                  event: "done",
                  payload: e.expiresAt ? { ok: true, expiresAt: e.expiresAt } : { ok: true },
                };
              }
              if (e.phase === "error") {
                return { event: "error", payload: { message: e.error ?? "unknown" } };
              }
              return { event: "state", payload: { phase: e.phase } };
            })();
            void stream.writeSSE({ event: data.event, data: JSON.stringify(data.payload) });
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown";
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message }) });
      }
    });
  });

  return app;
}
