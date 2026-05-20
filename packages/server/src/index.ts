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
import { authRoutes } from "./routes/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { userRoutes } from "./routes/user.js";
import { infraRoutes } from "./routes/infra.js";
import { deployRoutes } from "./routes/deploy.js";
import { agentGithubRoutes } from "./routes/agent-github.js";
import { packagesRoutes } from "./routes/packages.js";
import { PackageManager } from "./services/packages/manager.js";
import { VersionPoller } from "./services/packages/poller.js";
import { authMiddleware, adminMiddleware, agentAuthMiddleware } from "./middleware/auth.js";
import { githubAppManifestRoutes } from "./routes/github-app-manifest.js";
import {
  githubIntegrationRoutes,
  githubWebhookRoutes,
} from "./routes/github-integration.js";
import { installBackupRoutes } from "./routes/admin-install-backup.js";
import { adminAgentAuthRoutes } from "./routes/admin-agent-auth.js";
import { adminUpdatesRoutes } from "./routes/admin-updates.js";
import { workspaceEnvRoutes } from "./routes/workspace-env.js";
import { EnvOverrides } from "./services/images/env-overrides.js";
import { dockerRunningDigest } from "./services/images/manager.js";
import { ImagePoller } from "./services/images/poller.js";
import { DockerHubClient } from "./services/images/registry-client.js";
import { integrationsAgentsRoutes } from "./routes/integrations-agents.js";
import { ALLOWED_ORIGINS, isOriginAllowed } from "./middleware/origin.js";
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

const packageManager = new PackageManager(sessionManager);

// Bridge agent-side essentials.result messages into the user_packages
// table. Wired here (not in either manager's constructor) to avoid a
// circular import between SessionManager and PackageManager.
sessionManager.setEssentialsResultHandler((r) => {
  packageManager.recordEssentialResult(r.userId, r.packageId, r.ok, r.version, r.error);
});

const versionPoller = new VersionPoller();


// Reconnect active sessions on startup.
void (async () => {
  await sessionManager.reconnectActiveSessions();
})();

const app = new Hono();

app.use("*", logger());
// HSTS off: it's a footgun for the lan-http access mode. A single
// browser visit to https:// pins the browser to HTTPS for 6 months,
// even though the operator may legitimately prefer http:// on their
// LAN. Browsers correctly ignore HSTS sent over HTTP, but the prior
// HTTPS visit's header still sticks. Other secure headers (X-Frame-
// Options, X-Content-Type-Options, Referrer-Policy, etc.) stay on.
app.use("*", secureHeaders({ strictTransportSecurity: false }));

app.use(
  "/api/*",
  cors({ origin: [...ALLOWED_ORIGINS], credentials: true }),
);

// CSRF protection: require a trusted Origin on state-changing requests.
// See isOriginAllowed for the policy (explicit allowlist OR same-origin).
app.use("/api/*", async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  if (c.req.header("Authorization")?.startsWith("AgentToken ")) return next();

  if (!isOriginAllowed(c.req.header("Origin"), c.req.header("Host"))) {
    return c.json({ error: "Invalid origin" }, 403);
  }
  return next();
});

// --- /api/auth (login/logout public; /me + /change-password auth-protected inside authRoutes) ---
app.route("/api/auth", authRoutes());

// Baked into the server image at `docker build` time via ARG GIT_SHA
// → ENV AGENTHUB_GIT_SHA (see docker/Dockerfile.server). The update
// script (scripts/agenthub probe_front_door) polls this endpoint to
// confirm the newly-built container is actually serving traffic
// post-recreate, closing a class of silent-failure where compose
// recreated a container against a stale dangling image.
const SERVER_GIT_SHA = process.env["AGENTHUB_GIT_SHA"] ?? "unknown";
const SERVER_STARTED_AT = new Date().toISOString();
app.get("/api/health", async (c) => {
  // TLS health probe: skip for lan mode and localhost — no cert to probe.
  // Probe failure is reflected via tls.warnings — never crashes the endpoint.
  const domain =
    process.env["AGENTHUB_DOMAIN"] ?? process.env["DOMAIN"] ?? "localhost";
  const accessMode = process.env["AGENTHUB_ACCESS_MODE"] ?? "lan";
  let tls = null;
  if (accessMode === "lan" || domain === "localhost") {
    tls = {
      ok: true,
      domain,
      resolver: "lan" as const,
      issuer: "",
      notBefore: "",
      notAfter: "",
      daysToExpiry: null,
      warnings: [],
    };
  } else {
    try {
      const { getTlsHealth } = await import("./services/tls/health.js");
      tls = getTlsHealth(domain);
    } catch {
      // Defensive: if openssl is missing or the probe blows up, keep
      // /api/health responding healthy for the rest of the stack.
    }
  }
  return c.json({
    status: "ok",
    sha: SERVER_GIT_SHA,
    startedAt: SERVER_STARTED_AT,
    ...(tls ? { tls } : {}),
  });
});

// --- Agent-authenticated routes (MCP server inside workspace — before cookie auth) ---
const agentDeployApp = new Hono();
agentDeployApp.use("*", agentAuthMiddleware);
agentDeployApp.route("/", deployRoutes());
app.route("/api/agent/deploy", agentDeployApp);

const agentGithubApp = new Hono();
agentGithubApp.use("*", agentAuthMiddleware);
agentGithubApp.route("/", agentGithubRoutes());
app.route("/api/agent/github", agentGithubApp);

// --- GitHub App webhook (mounted BEFORE the /api/* auth middleware;
// verifies HMAC on the raw body instead of relying on our cookie auth). ---
app.route("/api/integrations/github/webhook", githubWebhookRoutes());

// --- Authenticated routes (skip agent-auth + webhook paths) ---
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/agent/")) return next();
  if (c.req.path === "/api/integrations/github/webhook") return next();
  return (authMiddleware as unknown as (c: unknown, next: () => Promise<void>) => Promise<Response | void>)(c, next);
});
app.route("/api/sessions", sessionsRoutes(sessionManager));
app.route("/api/sessions", previewRoutes(sessionManager));
app.route("/api/user", userRoutes(sessionManager));
app.route("/api/user/workspace-env", workspaceEnvRoutes());
app.route("/api/infra", infraRoutes());
app.route("/api/integrations/github", githubIntegrationRoutes());
app.route("/api/integrations/agents", integrationsAgentsRoutes(sessionManager));
app.route("/api/packages", packagesRoutes(packageManager));
app.route("/api", deployRoutes());

const envOverrides = new EnvOverrides({
  envPath: process.env["AGENTHUB_COMPOSE_ENV_FILE"] ?? "compose/.env",
});

// Periodically poll upstream registries for fresh CLI versions. Writes into
// package_version_cache; the Packages page reads from there. Tick interval
// is 30 minutes — npm doesn't publish often enough to warrant tighter.
versionPoller.start();

// Poll Docker Hub for fresh image versions. Writes into image_version_cache;
// the Updates page reads from there.
const imagePoller = new ImagePoller(envOverrides, new DockerHubClient());
imagePoller.start();

// --- Admin-only routes ---
app.use("/api/admin/*", adminMiddleware);
app.route("/api/admin", adminRoutes(sessionManager));
app.route("/api/admin/github-app", githubAppManifestRoutes());
app.route("/api/admin/install-backup", installBackupRoutes());
app.route("/api/admin/agent-auth", adminAgentAuthRoutes());
app.route("/api/admin/updates", adminUpdatesRoutes({
  env: envOverrides,
  runningDigest: dockerRunningDigest(),
}));

if (process.env["NODE_ENV"] === "production") {
  // Static assets for the React SPA + the Starlight docs site (the latter
  // lives under dist/public/docs/ — see packages/docs). Both are served by
  // the same serveStatic call because they share the same root.
  app.use("/*", serveStatic({ root: "./packages/server/dist/public" }));
  // Fallback for /docs/* misses: hand back Starlight's 404 page so docs
  // errors look like docs errors, not the SPA shell.
  app.get(
    "/docs/*",
    serveStatic({ path: "./packages/server/dist/public/docs/404.html" }),
  );
  // SPA fallback for everything else — client-side routing takes over.
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
  versionPoller.stop();
  imagePoller.stop();
  server.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
