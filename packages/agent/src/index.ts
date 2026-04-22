import { hostname } from "node:os";
import { chownSync, mkdirSync } from "node:fs";
import { AgentServer } from "./ws-server.js";
import { startFileServer } from "./file-server.js";

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

console.log(`[agent] starting on port ${String(PORT)}, host: ${hostname()}`);

const server = new AgentServer({ port: PORT, authToken: AUTH_TOKEN });
const fileServer = startFileServer();

console.log("[agent] ready");

process.on("SIGTERM", () => { server.close(); fileServer.close(); process.exit(0); });
process.on("SIGINT", () => { server.close(); fileServer.close(); process.exit(0); });
