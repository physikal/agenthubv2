import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { hydrateSession, type HydrateDeps } from "./credential-sync.js";
import type { AgentChannel } from "./orchestrator.js";

class FakeAgent extends EventEmitter implements AgentChannel {
  sent: unknown[] = [];
  send(m: unknown): void { this.sent.push(m); }
  override on(ev: "message", cb: (m: unknown) => void): this { super.on(ev, cb); return this; }
}

describe("hydrateSession", () => {
  it("probes daemon then pushes missing credentials from store", async () => {
    const agent = new FakeAgent();
    const deps: HydrateDeps = {
      getStored: async (_uid, toolId) => {
        if (toolId === "claude-code") {
          return { contents: "{\"x\":1}", filePath: "/home/coder/.claude/.credentials.json" };
        }
        return null;
      },
    };
    const run = hydrateSession({ userId: "u1", agent, deps });
    await new Promise((r) => setTimeout(r, 5));
    expect(agent.sent[0]).toMatchObject({ type: "auth.hydrateProbe" });
    agent.emit("message", {
      type: "auth.hydrateProbeResult",
      missing: [{ tool: "claude-code", path: "/home/coder/.claude/.credentials.json" }],
    });
    await run;
    const hydrateMsg = agent.sent.find(
      (m) => (m as { type: string }).type === "auth.hydrate",
    ) as { entries: Array<{ tool: string }> };
    expect(hydrateMsg).toBeDefined();
    expect(hydrateMsg.entries).toHaveLength(1);
    const entry = hydrateMsg.entries[0];
    expect(entry).toBeDefined();
    expect(entry!.tool).toBe("claude-code");
  });

  it("sends no hydrate when nothing is missing", async () => {
    const agent = new FakeAgent();
    const deps: HydrateDeps = { getStored: async () => null };
    const run = hydrateSession({ userId: "u1", agent, deps });
    await new Promise((r) => setTimeout(r, 5));
    agent.emit("message", { type: "auth.hydrateProbeResult", missing: [] });
    await run;
    const hydrateMsg = agent.sent.find((m) => (m as { type: string }).type === "auth.hydrate");
    expect(hydrateMsg).toBeUndefined();
  });
});
