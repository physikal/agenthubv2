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
  {
    id: "codex",
    displayName: "OpenAI Codex",
    loginCommand: "codex login",
    credentialPaths: ["/home/coder/.codex/auth.json"],
    urlPattern: /https:\/\/auth\.openai\.com\/[^\s]+/,
    loginTimeoutSec: 300,
  },
  {
    id: "gh",
    displayName: "GitHub CLI",
    loginCommand: "gh auth login --web --hostname github.com",
    logoutCommand: "gh auth logout --hostname github.com",
    credentialPaths: ["/home/coder/.config/gh/hosts.yml"],
    urlPattern: /https:\/\/github\.com\/login\/device/,
    loginTimeoutSec: 300,
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
