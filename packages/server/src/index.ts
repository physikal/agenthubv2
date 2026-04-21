import { createServer } from "node:http";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import { getRequestListener } from "@hono/node-server";
import { initDb } from "./db/index.js";
import { ProxmoxClient } from "./services/proxmox.js";
import { SessionManager } from "./services/session-manager.js";
import { ContainerPool } from "./services/pool.js";
import { sessionsRoutes } from "./routes/sessions.js";
import { settingsRoutes } from "./routes/settings.js";
import { containersRoutes } from "./routes/containers.js";
import { authRoutes } from "./routes/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { userRoutes } from "./routes/user.js";
import { infraRoutes } from "./routes/infra.js";
import { deployRoutes } from "./routes/deploy.js";
import { authMiddleware, adminMiddleware, agentAuthMiddleware } from "./middleware/auth.js";
import { setupTerminalProxy } from "./ws/terminal-proxy.js";
import { setupPreviewProxy } from "./ws/preview-proxy.js";
import { previewRoutes } from "./routes/preview.js";
import { isInLxcSubnet } from "./lib/subnet.js";

// Proxmox uses self-signed certs; we route PVE traffic through a scoped
// undici dispatcher (see lib/insecure-fetch.ts). Every other outbound HTTPS
// call (Cloudflare, DigitalOcean, future services) still verifies TLS.

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);

initDb();

const proxmox = new ProxmoxClient({
  baseUrl:
    process.env["PVE_API_URL"] ?? "https://192.168.5.100:8006/api2/json",
  tokenId: process.env["PVE_TOKEN_ID"] ?? "root@pam!agenthub",
  tokenSecret: process.env["PVE_TOKEN_SECRET"] ?? "",
  allowedNodes: (
    process.env["PVE_ALLOWED_NODES"] ?? "pve05,pve06,pve07"
  ).split(","),
  templateVmid: parseInt(process.env["PVE_TEMPLATE_VMID"] ?? "101", 10),
  storage: process.env["PVE_STORAGE"] ?? "pve06-vms",
});

const templateVmid = parseInt(
  process.env["PVE_TEMPLATE_VMID"] ?? "101",
  10,
);
const storage = process.env["PVE_STORAGE"] ?? "pve06-vms";
const pool = new ContainerPool(
  proxmox,
  templateVmid,
  storage,
  {
    targetSize: parseInt(process.env["POOL_SIZE"] ?? "1", 10),
    ttlMs: 7 * 24 * 60 * 60_000,
    checkIntervalMs: 60_000,
  },
  { pve05: "192.168.5.100", pve06: "192.168.5.101", pve07: "192.168.5.102" },
  process.env["AGENT_PORTAL_URL"] ?? "http://192.168.5.110:30080",
  process.env["AGENT_AUTH_TOKEN"] ?? "",
);

const sessionManager = new SessionManager(proxmox, templateVmid, pool);

// Startup order:
//   1. Reconnect active sessions so we know which VMIDs are session-owned.
//   2. Hydrate pool state from DB + reconcile with Proxmox (drops rows whose
//      containers disappeared while the server was down).
//   3. Destroy any lxc-pool-* that belongs to neither a session nor a pool row.
//   4. Begin maintaining target size.
void (async () => {
  await sessionManager.reconnectActiveSessions();
  await pool.hydrateFromDb();
  const activeSessions = sessionManager.listSessions()
    .filter((s) => !["completed", "failed"].includes(s.status))
    .map((s) => s.lxcVmid)
    .filter((v): v is number => v !== null);
  await pool.cleanupOrphans(new Set(activeSessions));
  pool.start();
})();

const app = new Hono();

app.use("*", logger());
app.use("*", secureHeaders());

export const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://localhost:3000",
  "https://agenthub.physhlab.com",
]);

app.use(
  "/api/*",
  cors({ origin: [...ALLOWED_ORIGINS], credentials: true }),
);

// CSRF protection: require a trusted Origin on state-changing requests.
// Previously we only rejected mismatched origins and allowed requests with
// no Origin header to pass — some browsers and older clients omit Origin on
// top-level form POSTs, and cookies still attach under SameSite=Lax. Now
// reject those unconditionally unless the caller uses AgentToken auth.
app.use("/api/*", async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  // Agent-token requests don't use cookies — skip CSRF check
  if (c.req.header("Authorization")?.startsWith("AgentToken ")) return next();
  const origin = c.req.header("Origin");
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return c.json({ error: "Invalid origin" }, 403);
  }
  return next();
});

// --- Public routes (no auth) ---
app.route("/api/auth", authRoutes());
app.get("/api/health", (c) => c.json({ status: "ok" }));
app.post("/api/agent/register", async (c) => {
  // Validate agent token to prevent session hijacking via fake registration
  const authHeader = c.req.header("Authorization");
  const expectedToken = process.env["AGENT_AUTH_TOKEN"];
  if (!expectedToken) return c.json({ error: "Server misconfigured" }, 500);
  if (authHeader !== `AgentToken ${expectedToken}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const body = await c.req.json<{ vmid: number; ip: string }>();
  if (!body.vmid || !body.ip) return c.json({ error: "vmid and ip required" }, 400);

  // Constrain reported IP to the LXC subnet. Without this, a rogue container
  // (that somehow obtained the shared token) could register a victim session
  // with ip=127.0.0.1 or ip=169.254.169.254 and hijack terminal/preview
  // traffic to internal services or cloud metadata endpoints.
  if (!isInLxcSubnet(body.ip)) {
    console.warn(
      `[agent-register] rejected vmid=${String(body.vmid)} ip=${body.ip} — outside LXC subnet`,
    );
    return c.json({ error: "reported ip not in LXC subnet" }, 400);
  }

  const ok = pool.registerAgent(body.vmid, body.ip);
  return c.json({ registered: ok });
});

// --- Agent-authenticated routes (MCP server in LXC — before blanket cookie auth) ---
const agentDeployApp = new Hono();
agentDeployApp.use("*", agentAuthMiddleware);
agentDeployApp.route("/", deployRoutes());
app.route("/api/agent/deploy", agentDeployApp);

// --- Auth-protected routes under /api/auth ---
app.get("/api/auth/me", authMiddleware);
app.post("/api/auth/change-password", authMiddleware);

// --- Authenticated routes (skip agent-auth paths) ---
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/agent/")) return next();
  return (authMiddleware as unknown as (c: unknown, next: () => Promise<void>) => Promise<Response | void>)(c, next);
});
app.route("/api/sessions", sessionsRoutes(sessionManager));
app.route("/api/sessions", previewRoutes(sessionManager));
app.route("/api/user", userRoutes());
app.route("/api/settings", settingsRoutes());
app.route("/api/infra", infraRoutes());
app.get("/api/pool", (c) => c.json(pool.getStatus()));
app.route("/api", deployRoutes());

// --- Admin-only routes ---
app.use("/api/admin/*", adminMiddleware);
app.route("/api/admin", adminRoutes(sessionManager));
app.route("/api/admin/containers", containersRoutes(proxmox));

if (process.env["NODE_ENV"] === "production") {
  app.use("/*", serveStatic({ root: "./packages/server/dist/public" }));
  app.get("*", serveStatic({ path: "./packages/server/dist/public/index.html" }));
}

const server = createServer(getRequestListener(app.fetch));

setupTerminalProxy(server, sessionManager);
setupPreviewProxy(server, sessionManager);

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${String(PORT)}`);
});

const shutdown = (): void => {
  console.log("[server] shutting down");
  pool.stop();
  server.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
