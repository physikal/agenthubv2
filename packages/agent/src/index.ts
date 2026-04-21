import { hostname, networkInterfaces } from "node:os";
import { AgentServer } from "./ws-server.js";
import { startFileServer } from "./file-server.js";

const PORT = parseInt(process.env["AGENT_PORT"] ?? "9876", 10);
const AUTH_TOKEN = process.env["AGENT_AUTH_TOKEN"] ?? "";
const PORTAL_URL = process.env["PORTAL_URL"] ?? "";

function getLocalIp(): string | null {
  const ifaces = networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (name === "lo" || !addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return null;
}

function getVmidFromHostname(): number | null {
  const h = hostname();
  const match = /(?:lxc-pool-|lxc-agent-)(\d+)/.exec(h);
  return match?.[1] ? parseInt(match[1], 10) : null;
}

async function registerWithPortal(): Promise<void> {
  if (!PORTAL_URL) return;
  const ip = getLocalIp();
  const vmid = getVmidFromHostname();
  if (!ip || !vmid) return;

  for (let i = 0; i < 15; i++) {
    try {
      const resp = await fetch(`${PORTAL_URL}/api/agent/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `AgentToken ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({ vmid, ip }),
      });
      if (resp.ok) { console.log("[agent] registered"); return; }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

console.log(`[agent] starting on port ${String(PORT)}, host: ${hostname()}`);

const server = new AgentServer({ port: PORT, authToken: AUTH_TOKEN });
const fileServer = startFileServer();

console.log("[agent] ready");
void registerWithPortal();

process.on("SIGTERM", () => { server.close(); fileServer.close(); process.exit(0); });
process.on("SIGINT", () => { server.close(); fileServer.close(); process.exit(0); });
