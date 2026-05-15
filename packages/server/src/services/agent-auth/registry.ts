export interface AgentTool {
  id: string;
  displayName: string;
  loginCommand: string;
  logoutCommand?: string;
  credentialPaths: string[];
  urlPattern: RegExp;
  loginTimeoutSec: number;
  expiryParser?: (fileContents: string) => Date | null;
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    loginCommand: "claude /login",
    logoutCommand: "claude /logout",
    credentialPaths: ["/home/coder/.claude/.credentials.json"],
    urlPattern: /https:\/\/claude\.ai\/oauth\/authorize\?[^\s]+/,
    loginTimeoutSec: 300,
    expiryParser: parseClaudeExpiry,
  },
];

export function getTool(id: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.id === id);
}

function parseClaudeExpiry(contents: string): Date | null {
  try {
    const parsed = JSON.parse(contents) as { expiresAt?: number; expires_at?: number };
    const epochMs = parsed.expiresAt ?? parsed.expires_at;
    return typeof epochMs === "number" ? new Date(epochMs) : null;
  } catch {
    return null;
  }
}
