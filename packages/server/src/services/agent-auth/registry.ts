export interface AgentTool {
  id: string;
  displayName: string;
  loginCommand: string;
  logoutCommand?: string;
  credentialPaths: string[];
  urlPattern: RegExp;
  /** If set, lines matching this regex emit a `code` event to the UI. For
   * device-code flows (codex --device-auth, gh) where the CLI prints a
   * short code the user enters at the OAuth URL. */
  codePattern?: RegExp;
  /** If true, the CLI is waiting on stdin for the user to paste back a
   * code from the OAuth provider's confirmation page. The modal renders
   * a paste field; submitted text is piped to the subprocess's stdin. */
  acceptsCodeInput?: boolean;
  loginTimeoutSec: number;
  expiryParser?: (fileContents: string) => Date | null;
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    loginCommand: "claude auth login --claudeai",
    logoutCommand: "claude auth logout",
    credentialPaths: ["/home/coder/.claude/.credentials.json"],
    urlPattern: /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s]+/,
    acceptsCodeInput: true,
    loginTimeoutSec: 300,
    expiryParser: parseClaudeExpiry,
  },
  {
    id: "codex",
    displayName: "OpenAI Codex",
    loginCommand: "codex login --device-auth",
    credentialPaths: ["/home/coder/.codex/auth.json"],
    urlPattern: /https:\/\/auth\.openai\.com\/codex\/device/,
    codePattern: /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/,
    loginTimeoutSec: 900,
    expiryParser: parseClaudeExpiry,
  },
  {
    id: "gh",
    displayName: "GitHub CLI",
    loginCommand: "gh auth login --web --hostname github.com",
    logoutCommand: "gh auth logout --hostname github.com",
    credentialPaths: ["/home/coder/.config/gh/hosts.yml"],
    urlPattern: /https:\/\/github\.com\/login\/device/,
    codePattern: /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/,
    loginTimeoutSec: 900,
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
