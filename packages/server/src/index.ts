import { createServer } from "node:http";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import { getRequestListener } from "@hono/node-server";
import { initDb } from "./db/index.js";
import { SessionManager } from "./services/session-manager.js";
import { createProvisioner } from "./services/provisioner/index.js";
import { sessionsRoutes } from "./routes/sessions.js";
import { settingsRoutes } from "./routes/settings.js";
import { authRoutes } from "./routes/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { userRoutes } from "./routes/user.js";
import { infraRoutes } from "./routes/infra.js";
import { deployRoutes } from "./routes/deploy.js";
import { authMiddleware, adminMiddleware, agentAuthMiddleware } from "./middleware/auth.js";
import { setupTerminalProxy } from "./ws/terminal-proxy.js";
import { setupPreviewProxy } from "./ws/preview-proxy.js";
import { previewRoutes } from "./routes/preview.js";

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);

initDb();

const provisioner = createProvisioner();
const workspaceImage =
  process.env["WORKSPACE_IMAGE"] ??
  "ghcr.io/physikal/agenthubv2-workspace:latest";
const portalUrl =
  process.env["AGENTHUB_PORTAL_URL"] ?? `http://host.docker.internal:${String(PORT)}`;

const sessionManager = new SessionManager({
  provisioner,
  workspaceImage,
  portalUrl,
});

// Reconnect active sessions on startup. Previously this also hydrated a warm
// pool and cleaned up orphaned LXCs — v2 has neither.
void (async () => {
  await sessionManager.reconnectActiveSessions();
})();

const app = new Hono();

app.use("*", logger());
app.use("*", secureHeaders());

function parseOrigins(): Set<string> {
  const base = new Set<string>([
    "http://localhost:5173",
    "http://localhost:3000",
    `http://localhost:${String(PORT)}`,
  ]);
  const configured = process.env["AGENTHUB_PUBLIC_URL"];
  if (configured) base.add(configured.replace(/\/$/, ""));
  const extra = process.env["AGENTHUB_ALLOWED_ORIGINS"];
  if (extra) {
    for (const o of extra.split(",").map((s) => s.trim()).filter(Boolean)) {
      base.add(o);
    }
  }
  return base;
}

export const ALLOWED_ORIGINS = parseOrigins();

app.use(
  "/api/*",
  cors({ origin: [...ALLOWED_ORIGINS], credentials: true }),
);

// CSRF protection: require a trusted Origin on state-changing requests.
app.use("/api/*", async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  if (c.req.header("Authorization")?.startsWith("AgentToken ")) return next();
  const origin = c.req.header("Origin");
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return c.json({ error: "Invalid origin" }, 403);
  }
  return next();
});

// --- /api/auth (login/logout public; /me + /change-password auth-protected inside authRoutes) ---
app.route("/api/auth", authRoutes());
app.get("/api/health", (c) => c.json({ status: "ok" }));

// --- Agent-authenticated routes (MCP server inside workspace — before cookie auth) ---
const agentDeployApp = new Hono();
agentDeployApp.use("*", agentAuthMiddleware);
agentDeployApp.route("/", deployRoutes());
app.route("/api/agent/deploy", agentDeployApp);

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
app.route("/api", deployRoutes());

// --- Admin-only routes ---
app.use("/api/admin/*", adminMiddleware);
app.route("/api/admin", adminRoutes(sessionManager));

if (process.env["NODE_ENV"] === "production") {
  app.use("/*", serveStatic({ root: "./packages/server/dist/public" }));
  app.get("*", serveStatic({ path: "./packages/server/dist/public/index.html" }));
}

const server = createServer(getRequestListener(app.fetch));

setupTerminalProxy(server, sessionManager);
setupPreviewProxy(server, sessionManager);

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${String(PORT)}`);
  console.log(`[server] provisioner mode: ${provisioner.mode}`);
});

const shutdown = (): void => {
  console.log("[server] shutting down");
  server.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
