import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { SessionManager } from "../services/session-manager.js";
import type { AuthUser } from "../middleware/auth.js";
import { isInLxcSubnet } from "../lib/subnet.js";

const AGENT_FILE_SERVER_PORT = 9877;

/**
 * Headers we never forward UPSTREAM — prevents the preview-port proxy from
 * leaking user auth to a workspace web server. An attacker-controlled app
 * running in the LXC would otherwise see the browser's AgentHub cookie
 * (already stripped elsewhere) and the raw `Authorization` header.
 */
const OUTBOUND_BLOCKLIST = new Set([
  "host", "connection", "keep-alive", "transfer-encoding", "upgrade",
  "cookie", "authorization", "proxy-authorization",
]);

export function previewRoutes(sessionManager: SessionManager) {
  const app = new Hono<{ Variables: { user: AuthUser } }>();

  // File preview: /sessions/:id/preview/file/*
  app.get("/:id/preview/file/*", async (c) => {
    const sessionId = c.req.param("id");
    const user = c.get("user");
    const session = sessionManager.getSession(sessionId);

    if (!session) return c.json({ error: "Session not found" }, 404);
    if (session.userId !== user.id && user.role !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }
    if (!session.lxcIp) {
      return c.json({ error: "Container not ready" }, 503);
    }
    if (!isInLxcSubnet(session.lxcIp)) {
      return c.json({ error: "Invalid container IP" }, 502);
    }

    // Extract file path from URL after /preview/file/
    const url = new URL(c.req.url);
    const prefixIdx = url.pathname.indexOf("/preview/file/");
    if (prefixIdx === -1) return c.json({ error: "Invalid path" }, 400);
    const filePath = url.pathname.slice(
      prefixIdx + "/preview/file/".length,
    );
    if (!filePath) return c.json({ error: "No file path" }, 400);

    const fileUrl = `http://${session.lxcIp}:${String(AGENT_FILE_SERVER_PORT)}/${filePath}`;

    try {
      const upstream = await fetch(fileUrl);

      if (!upstream.ok) {
        return c.json(
          { error: "File not found" },
          upstream.status as 404 | 500,
        );
      }

      const contentType = upstream.headers.get("content-type")
        ?? "application/octet-stream";
      const contentLength = upstream.headers.get("content-length");

      c.header("Content-Type", contentType);
      if (contentLength) c.header("Content-Length", contentLength);

      return stream(c, async (s) => {
        if (!upstream.body) return;
        const reader = upstream.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await s.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.error(
        `[preview] file proxy error for ${sessionId}: ${msg}`,
      );
      return c.json({ error: "Failed to fetch file" }, 502);
    }
  });

  // Port preview: /sessions/:id/preview/port/:port/*
  app.all("/:id/preview/port/:port/*", async (c) => {
    const sessionId = c.req.param("id");
    const port = c.req.param("port");
    const user = c.get("user");
    const session = sessionManager.getSession(sessionId);

    if (!session) return c.json({ error: "Session not found" }, 404);
    if (session.userId !== user.id && user.role !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }
    if (!session.lxcIp) {
      return c.json({ error: "Container not ready" }, 503);
    }
    if (!isInLxcSubnet(session.lxcIp)) {
      return c.json({ error: "Invalid container IP" }, 502);
    }

    const portNum = parseInt(port, 10);
    if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return c.json({ error: "Invalid port" }, 400);
    }

    // Extract path after /preview/port/{port}/
    const url = new URL(c.req.url);
    const portPrefix = `/preview/port/${port}/`;
    const prefixIdx = url.pathname.indexOf(portPrefix);
    const remainingPath = prefixIdx !== -1
      ? url.pathname.slice(prefixIdx + portPrefix.length)
      : "";
    const queryString = url.search;

    const targetUrl =
      `http://${session.lxcIp}:${String(portNum)}/${remainingPath}${queryString}`;

    try {
      // Forward the request with original method, headers, and body.
      // Authorization/cookie are stripped so a workspace web server can't
      // observe the browser's AgentHub credentials.
      const headers = new Headers();
      for (const [key, value] of Object.entries(c.req.header())) {
        if (!value) continue;
        if (OUTBOUND_BLOCKLIST.has(key.toLowerCase())) continue;
        headers.set(key, value);
      }

      const method = c.req.method;
      const body = method !== "GET" && method !== "HEAD"
        ? await c.req.arrayBuffer()
        : null;

      const upstream = await fetch(targetUrl, { method, headers, body });

      // Build response headers
      const responseHeaders = new Headers();
      upstream.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (
          lower === "transfer-encoding" || lower === "connection"
        ) return;

        // Location rewrite for redirects. Any Location pointing outside
        // the LXC IP is replaced with a safe path-only redirect back to
        // the proxy root — stops upstream-controlled open redirects that
        // could leak the AgentHub session cookie to a third-party host
        // when the browser follows the 3xx in an iframe context.
        if (lower === "location" && upstream.status >= 300 && upstream.status < 400) {
          try {
            const loc = new URL(value, targetUrl);
            const proxyBase = url.pathname.slice(
              0,
              prefixIdx !== -1 ? prefixIdx + portPrefix.length : 0,
            );
            if (loc.hostname === session.lxcIp) {
              responseHeaders.set(
                key,
                `${proxyBase}${loc.pathname.slice(1)}${loc.search}`,
              );
              return;
            }
            // Cross-origin redirect — drop to the proxy root rather than
            // forwarding the external URL.
            console.warn(
              `[preview] blocking cross-origin redirect for ${sessionId}:${port} → ${loc.origin}`,
            );
            responseHeaders.set(key, proxyBase);
            return;
          } catch {
            // Malformed Location — drop it entirely rather than forward.
            return;
          }
        }
        responseHeaders.set(key, value);
      });

      return stream(c, async (s) => {
        // Set status and headers on the raw response
        c.status(upstream.status as Parameters<typeof c.status>[0]);
        responseHeaders.forEach((value, key) => {
          c.header(key, value);
        });

        if (!upstream.body) return;
        const reader = upstream.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await s.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.error(
        `[preview] port proxy error for ${sessionId}:${port}: ${msg}`,
      );
      return c.json({ error: "Failed to reach service" }, 502);
    }
  });

  return app;
}
