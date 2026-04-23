/**
 * Register the agentdeploy MCP server with every supported coding CLI that
 * gets installed into the workspace (built-in or via the Packages page).
 *
 * This runs from the agent daemon at workspace-container startup. The daemon
 * is PID 1 as root; the config files live under /home/coder (uid 1000), so
 * we write atomically and chown back to coder.
 *
 * Merge semantics: every writer reads any pre-existing config, adds/updates
 * ONLY the `agentdeploy` entry, and leaves every other MCP server entry
 * alone. That means a user's prior MCP registrations (Notion, Linear, etc.)
 * survive across session destroys — the `agenthub-home-{userId}` volume
 * persists their configs, and our writer respects them.
 *
 * Per-CLI schemas differ:
 *   Claude Code  ~/.claude.json         .mcpServers.agentdeploy  (stdio; {command, args, env})
 *   OpenCode     ~/.config/opencode/opencode.json  .mcp.agentdeploy  (type: "local"; command as array; environment block)
 *   Droid (Factory)  ~/.factory/mcp.json  .mcpServers.agentdeploy  (type: "stdio"; {command, args, env, disabled})
 */

import { mkdirSync, readFileSync, writeFileSync, chownSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";

const CODER_UID = 1000;
const CODER_GID = 1000;

export interface RegisterMcpOptions {
  /** Absolute path of the agentdeploy MCP entrypoint inside the workspace. */
  mcpBinary: string;
  /** AgentHub server URL the MCP calls back to. */
  portalUrl: string;
  /** Per-session agent token. */
  agentToken: string;
  /** Typically "/home/coder". */
  coderHome: string;
  log: (line: string) => void;
}

/**
 * Write/merge the agentdeploy MCP into every supported CLI's config. Never
 * throws — each CLI is independent; a failure for one is logged and the
 * rest still run.
 */
export function registerAgentDeployMcp(opts: RegisterMcpOptions): void {
  const writers: Array<readonly [string, (o: RegisterMcpOptions) => void]> = [
    ["claude-code", writeClaudeCode],
    ["opencode", writeOpenCode],
    ["droid", writeDroid],
  ];
  for (const [name, fn] of writers) {
    try {
      fn(opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.log(`${name}: skipped (${msg})`);
    }
  }
}

// ---------- Claude Code ----------

interface ClaudeCodeMcpEntry {
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
}

interface ClaudeCodeConfig {
  mcpServers?: Record<string, ClaudeCodeMcpEntry>;
  [key: string]: unknown;
}

function writeClaudeCode(o: RegisterMcpOptions): void {
  const path = `${o.coderHome}/.claude.json`;
  const existing = readJsonOrEmpty<ClaudeCodeConfig>(path);
  const entry: ClaudeCodeMcpEntry = {
    command: "node",
    args: [o.mcpBinary],
    env: {
      PORTAL_URL: o.portalUrl,
      AGENT_TOKEN: o.agentToken,
    },
  };
  const mcpServers = { ...(existing.mcpServers ?? {}), agentdeploy: entry };
  const next: ClaudeCodeConfig = { ...existing, mcpServers };
  writeJsonAtomic(path, next);
  o.log(`claude-code: registered agentdeploy in ${path}`);
}

// ---------- OpenCode (sst/opencode) ----------

interface OpenCodeMcpEntry {
  type: "local";
  command: readonly string[];
  enabled: boolean;
  environment?: Record<string, string>;
}

interface OpenCodeConfig {
  mcp?: Record<string, OpenCodeMcpEntry>;
  [key: string]: unknown;
}

function writeOpenCode(o: RegisterMcpOptions): void {
  const dir = `${o.coderHome}/.config/opencode`;
  const path = `${dir}/opencode.json`;
  const existing = readJsonOrEmpty<OpenCodeConfig>(path);
  const entry: OpenCodeMcpEntry = {
    type: "local",
    command: ["node", o.mcpBinary],
    enabled: true,
    environment: {
      PORTAL_URL: o.portalUrl,
      AGENT_TOKEN: o.agentToken,
    },
  };
  const mcp = { ...(existing.mcp ?? {}), agentdeploy: entry };
  const next: OpenCodeConfig = { ...existing, mcp };
  writeJsonAtomic(path, next);
  o.log(`opencode: registered agentdeploy in ${path}`);
}

// ---------- Droid (Factory AI) ----------

interface DroidMcpEntry {
  type: "stdio";
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

interface DroidConfig {
  mcpServers?: Record<string, DroidMcpEntry>;
  [key: string]: unknown;
}

function writeDroid(o: RegisterMcpOptions): void {
  const dir = `${o.coderHome}/.factory`;
  const path = `${dir}/mcp.json`;
  const existing = readJsonOrEmpty<DroidConfig>(path);
  const entry: DroidMcpEntry = {
    type: "stdio",
    command: "node",
    args: [o.mcpBinary],
    env: {
      PORTAL_URL: o.portalUrl,
      AGENT_TOKEN: o.agentToken,
    },
    disabled: false,
  };
  const mcpServers = { ...(existing.mcpServers ?? {}), agentdeploy: entry };
  const next: DroidConfig = { ...existing, mcpServers };
  writeJsonAtomic(path, next);
  o.log(`droid: registered agentdeploy in ${path}`);
}

// ---------- shared helpers ----------

function readJsonOrEmpty<T extends object>(path: string): T {
  if (!existsSync(path)) return {} as T;
  try {
    const raw = readFileSync(path, "utf-8");
    if (!raw.trim()) return {} as T;
    return JSON.parse(raw) as T;
  } catch {
    // Corrupt or unreadable config. Better to stomp than fail to register.
    // The replaced file still contains only our single known-good entry.
    return {} as T;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const parent = dirname(path);
  ensureOwnedDir(parent);
  const tmp = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chownIfRoot(tmp);
  renameSync(tmp, path);
  chownIfRoot(path);
}

function ensureOwnedDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o755 });
  chownIfRoot(path);
}

function chownIfRoot(path: string): void {
  // Running as root (PID 1 of the workspace container). If we're not root
  // — e.g., a test running on a dev box — skip silently; the file stays
  // owned by whoever's running.
  if (process.getuid?.() !== 0) return;
  try {
    chownSync(path, CODER_UID, CODER_GID);
  } catch {
    // Best-effort. If chown fails, the file is still functional; it just
    // may be owned by root, which the coder user can't modify via `claude
    // mcp add` later. Log-and-continue is handled by the caller.
  }
}
