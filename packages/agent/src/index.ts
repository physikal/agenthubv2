import { hostname } from "node:os";
import { chownSync, mkdirSync } from "node:fs";
import { AgentServer } from "./ws-server.js";
import { startFileServer } from "./file-server.js";
import { registerAgentDeployMcp } from "./mcp-writer.js";
import { installGitCredentialsFromEnv } from "./github-credentials.js";
import { AuthHandler } from "./auth/handler.js";
import { CredentialWatcher } from "./auth/cred-watcher.js";

const PORT = parseInt(process.env["AGENT_PORT"] ?? "9876", 10);
const AUTH_TOKEN = process.env["AGENT_TOKEN"] ?? "";

// Ensure the per-user package install prefix exists and is coder-owned so
// `npm install --prefix ~/.local -g` and curl-based installers can write.
// Idempotent — safe to run on every startup.
try {
  const localBin = "/home/coder/.local/bin";
  const localLib = "/home/coder/.local/lib";
  mkdirSync(localBin, { recursive: true });
  mkdirSync(localLib, { recursive: true });
  chownSync("/home/coder/.local", 1000, 1000);
  chownSync(localBin, 1000, 1000);
  chownSync(localLib, 1000, 1000);
} catch (err) {
  const msg = err instanceof Error ? err.message : "unknown";
  console.warn(`[agent] could not prepare /home/coder/.local: ${msg}`);
}

// If the server injected a GitHub App installation token via env vars,
// write ~/.gitconfig so every `git clone`/`git push` inside the workspace
// is authenticated transparently. No-op when GITHUB_TOKEN is absent.
installGitCredentialsFromEnv();

// Register the agentdeploy MCP with every supported coding CLI so Claude
// Code / OpenCode / Droid pick it up automatically on first run. Merges
// into any pre-existing config (a user's Notion MCP etc. survives). Non-
// fatal — daemon keeps running even if every writer fails.
try {
  registerAgentDeployMcp({
    mcpBinary: "/opt/agenthub-agent/mcp-deploy.js",
    portalUrl: process.env["PORTAL_URL"] ?? "",
    agentToken: AUTH_TOKEN,
    coderHome: "/home/coder",
    log: (line) => console.log(`[mcp-writer] ${line}`),
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : "unknown";
  console.warn(`[mcp-writer] unexpected failure: ${msg}`);
}

console.log(`[agent] starting on port ${String(PORT)}, host: ${hostname()}`);

const server = new AgentServer({ port: PORT, authToken: AUTH_TOKEN });
const fileServer = startFileServer();

const authHandler = new AuthHandler({ send: (m) => server.send(m) });
server.setAuthRouter((m) => authHandler.handle(m));

const watcher = new CredentialWatcher({
  send: (m) => server.send(m),
  // 200ms debounce: long enough to coalesce atomic-rename sequences (write
  // .tmp + rename), short enough that token-refresh writes are mirrored
  // back to Infisical promptly without delaying the connect flow.
  debounceMs: 200,
  tools: [
    { tool: "claude-code", paths: ["/home/coder/.claude/.credentials.json"] },
    { tool: "codex",       paths: ["/home/coder/.codex/auth.json"] },
    { tool: "gh",          paths: ["/home/coder/.config/gh/hosts.yml"] },
  ],
});
watcher.start();

console.log("[agent] ready");

process.on("SIGTERM", () => { watcher.stop(); server.close(); fileServer.close(); process.exit(0); });
process.on("SIGINT", () => { watcher.stop(); server.close(); fileServer.close(); process.exit(0); });
