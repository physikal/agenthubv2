import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Orchestrator, type OrchestratorEvent, type AgentChannel } from "./orchestrator.js";
import type { SecretStore } from "../secrets/index.js";

class FakeAgent extends EventEmitter implements AgentChannel {
  sent: unknown[] = [];
  send(msg: unknown): void { this.sent.push(msg); }
  override on(ev: "message", cb: (msg: unknown) => void): this { super.on(ev, cb); return this; }
}

class FakeSessions {
  _last?: FakeAgent;
  destroyed: string[] = [];
  async createAuthHelper(_userId: string): Promise<{ sessionId: string; agent: AgentChannel }> {
    const agent = new FakeAgent();
    this._last = agent;
    return { sessionId: "sess-1", agent };
  }
  async destroy(sessionId: string): Promise<void> { this.destroyed.push(sessionId); }
}

class FakeStore implements SecretStore {
  configured = true;
  written = new Map<string, Record<string, string>>();
  async getSecret(p: string, n: string): Promise<string | null> { return this.written.get(p)?.[n] ?? null; }
  async getAllSecrets(_p: string): Promise<Record<string, string>> { return {}; }
  async setSecret(p: string, n: string, v: string): Promise<void> {
    this.written.set(p, { ...(this.written.get(p) ?? {}), [n]: v });
  }
  async setSecrets(p: string, vs: Record<string, string>): Promise<void> {
    this.written.set(p, { ...(this.written.get(p) ?? {}), ...vs });
  }
  async deleteSecret(p: string, n: string): Promise<void> {
    const o = this.written.get(p);
    if (o) delete o[n];
  }
  async deletePath(p: string): Promise<void> { this.written.delete(p); }
}

describe("Orchestrator.connect", () => {
  it("emits preparing → awaiting-url → captured → done and writes Infisical", async () => {
    const sessions = new FakeSessions();
    const store = new FakeStore();
    const audits: unknown[] = [];
    const orch = new Orchestrator({
      sessions: sessions as never,
      store,
      audit: async (e) => { audits.push(e); },
    });

    const events: OrchestratorEvent[] = [];
    const run = orch.connect({ userId: "u1", toolId: "claude-code", onEvent: (e) => events.push(e) });

    // Wait until the orchestrator has spawned an agent and subscribed.
    await new Promise((r) => setTimeout(r, 5));
    const agent = sessions._last;
    expect(agent).toBeDefined();
    agent!.emit("message", { type: "auth.line", tool: "claude-code", stream: "stdout", line: "Visit https://claude.ai/oauth/authorize?x=1" });
    agent!.emit("message", { type: "auth.captured", tool: "claude-code", path: "/home/coder/.claude/.credentials.json", contentsBase64: Buffer.from("{}").toString("base64") });
    agent!.emit("message", { type: "auth.done", tool: "claude-code", ok: true });

    await run;

    const phases = events.map((e) => e.phase);
    expect(phases).toEqual(["preparing", "awaiting-url", "awaiting-callback", "captured", "done"]);
    expect(store.written.get("/users/u1/agents/claude-code")).toBeDefined();
    expect(sessions.destroyed).toEqual(["sess-1"]);
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Orchestrator.disconnect", () => {
  it("messages the daemon, deletes Infisical entry, audits", async () => {
    const sessions = new FakeSessions();
    const store = new FakeStore();
    await store.setSecrets("/users/u1/agents/claude-code", { credentials: "x" });
    const audits: unknown[] = [];
    const orch = new Orchestrator({
      sessions: sessions as never,
      store,
      audit: async (e) => { audits.push(e); },
    });

    const run = orch.disconnect({ userId: "u1", toolId: "claude-code" });
    await new Promise((r) => setTimeout(r, 5));
    const agent = sessions._last;
    expect(agent).toBeDefined();
    agent!.emit("message", { type: "auth.disconnected", tool: "claude-code", ok: true });
    await run;

    expect(store.written.get("/users/u1/agents/claude-code")).toBeUndefined();
    expect(sessions.destroyed).toEqual(["sess-1"]);
    expect(audits).toHaveLength(1);
    expect((audits[0] as { action: string }).action).toBe("disconnect");
  });
});

describe("Orchestrator.status", () => {
  it("returns connected when credential exists in Infisical", async () => {
    const store = new FakeStore();
    await store.setSecrets("/users/u1/agents/claude-code", { credentials: "{}" });
    const orch = new Orchestrator({
      sessions: {} as never,
      store,
      audit: async () => undefined,
    });
    const s = await orch.status({ userId: "u1", toolId: "claude-code" });
    expect(s.status).toBe("connected");
  });

  it("returns disconnected when no credential present", async () => {
    const orch = new Orchestrator({
      sessions: {} as never,
      store: new FakeStore(),
      audit: async () => undefined,
    });
    const s = await orch.status({ userId: "u1", toolId: "codex" });
    expect(s.status).toBe("disconnected");
  });

  it("returns disconnected when toolId is not registered", async () => {
    const orch = new Orchestrator({
      sessions: {} as never,
      store: new FakeStore(),
      audit: async () => undefined,
    });
    const s = await orch.status({ userId: "u1", toolId: "not-a-tool" });
    expect(s.status).toBe("disconnected");
    expect(s.id).toBe("not-a-tool");
  });
});
