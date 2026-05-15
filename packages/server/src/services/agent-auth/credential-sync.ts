import { AGENT_TOOLS } from "./registry.js";
import type { AgentChannel } from "./orchestrator.js";

export interface StoredCredential {
  contents: string;
  filePath: string;
}

export interface HydrateDeps {
  getStored(userId: string, toolId: string): Promise<StoredCredential | null>;
}

export async function hydrateSession(args: {
  userId: string;
  agent: AgentChannel;
  deps: HydrateDeps;
}): Promise<void> {
  const tools = AGENT_TOOLS.map((t) => ({ tool: t.id, paths: t.credentialPaths }));

  const probe = new Promise<Array<{ tool: string; path: string }>>((resolve) => {
    args.agent.on("message", (raw) => {
      const m = raw as { type: string; missing?: unknown };
      if (m.type === "auth.hydrateProbeResult") {
        resolve((m.missing as Array<{ tool: string; path: string }>) ?? []);
      }
    });
  });

  args.agent.send({ type: "auth.hydrateProbe", tools });

  const missing = await probe;
  if (missing.length === 0) return;

  const entries: Array<{ tool: string; path: string; contentsBase64: string }> = [];
  for (const m of missing) {
    const stored = await args.deps.getStored(args.userId, m.tool);
    if (!stored) continue;
    entries.push({
      tool: m.tool,
      path: m.path,
      contentsBase64: Buffer.from(stored.contents).toString("base64"),
    });
  }

  if (entries.length === 0) return;
  args.agent.send({ type: "auth.hydrate", entries });
}
