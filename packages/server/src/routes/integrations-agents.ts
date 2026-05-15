import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AuthUser } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { Orchestrator, type OrchestratorEvent } from "../services/agent-auth/orchestrator.js";
import { AGENT_TOOLS } from "../services/agent-auth/registry.js";
import { writeAudit } from "../services/agent-auth/audit.js";
import { getSecretStore } from "../services/secrets/index.js";
import type { SessionManager } from "../services/session-manager.js";

interface SSEPair {
  event: string;
  payload: Record<string, unknown>;
}

function eventFor(e: OrchestratorEvent): SSEPair {
  if (e.code) {
    return { event: "code", payload: { code: e.code } };
  }
  if (e.phase === "awaiting-url" && e.url) {
    const payload: Record<string, unknown> = { url: e.url };
    if (e.acceptsCodeInput) payload["acceptsCodeInput"] = true;
    return { event: "url", payload };
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
}

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
            const sse = eventFor(e);
            void stream.writeSSE({ event: sse.event, data: JSON.stringify(sse.payload) });
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
            const sse = eventFor(e);
            void stream.writeSSE({ event: sse.event, data: JSON.stringify(sse.payload) });
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown";
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message }) });
      }
    });
  });

  app.post("/:toolId/input", async (c) => {
    const user = c.get("user");
    const toolId = c.req.param("toolId");
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const text = typeof body["text"] === "string" ? body["text"] : "";
    if (!text) return c.json({ error: "text required" }, 400);
    orch.relayInput({ userId: user.id, toolId, text });
    return c.json({ ok: true });
  });

  return app;
}
