import { useEffect, useState, useCallback } from "react";

export interface AgentStatus {
  id: string;
  displayName: string;
  status: "connected" | "disconnected";
  expiresAt?: string;
}

export function useAgentStatus(): { tools: AgentStatus[]; refresh: () => Promise<void> } {
  const [tools, setTools] = useState<AgentStatus[]>([]);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/integrations/agents", { credentials: "include" });
    if (!r.ok) return;
    const j = (await r.json()) as { tools: AgentStatus[] };
    setTools(j.tools);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { tools, refresh };
}
