import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { integrationsAgentsRoutes } from "./integrations-agents.js";
import type { SessionManager } from "../services/session-manager.js";
import type { AuthUser } from "../middleware/auth.js";

// SessionManager is only used inside the orchestrator for connect/disconnect.
// The GET / handler never invokes session methods, so a stub with throw-on-call
// fakes is fine.
function fakeSessionManager(): SessionManager {
  return {
    createAuthHelper: () => {
      throw new Error("not used by GET /");
    },
    destroy: () => {
      throw new Error("not used by GET /");
    },
  } as unknown as SessionManager;
}

describe("integrations-agents routes", () => {
  it("GET / returns all registered tools with disconnected status", async () => {
    const agentsApp = integrationsAgentsRoutes(fakeSessionManager());

    // Wrap in a parent Hono instance so the auth-stub middleware runs before
    // the route handlers. app.use() on an already-built sub-app doesn't
    // reorder handlers; mounting via .route() does.
    const wrapper = new Hono<{ Variables: { user: AuthUser } }>();
    wrapper.use("*", async (c, next) => {
      c.set("user", { id: "test-user", username: "tester", role: "user" });
      return next();
    });
    wrapper.route("/", agentsApp);

    const res = await wrapper.request("/");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { tools: Array<{ id: string; status: string }> };
    expect(body.tools.map((t) => t.id).sort()).toEqual(["claude-code", "codex", "gh"]);
    for (const t of body.tools) {
      expect(t.status).toBe("disconnected");
    }
  });
});
