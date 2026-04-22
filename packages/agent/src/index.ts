import { hostname } from "node:os";
import { AgentServer } from "./ws-server.js";
import { startFileServer } from "./file-server.js";

const PORT = parseInt(process.env["AGENT_PORT"] ?? "9876", 10);
const AUTH_TOKEN = process.env["AGENT_TOKEN"] ?? "";

console.log(`[agent] starting on port ${String(PORT)}, host: ${hostname()}`);

const server = new AgentServer({ port: PORT, authToken: AUTH_TOKEN });
const fileServer = startFileServer();

console.log("[agent] ready");

process.on("SIGTERM", () => { server.close(); fileServer.close(); process.exit(0); });
process.on("SIGINT", () => { server.close(); fileServer.close(); process.exit(0); });
