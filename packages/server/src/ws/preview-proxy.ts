import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { SessionManager } from "../services/session-manager.js";
import { authenticateToken } from "../middleware/auth.js";
import { ALLOWED_ORIGINS } from "../index.js";

const PATH_PATTERN = /^\/api\/sessions\/([^/]+)\/preview\/port\/(\d+)(\/.*)?$/;
const BACKPRESSURE_BYTES = 1_000_000;
const HEARTBEAT_MS = 30_000;

export function setupPreviewProxy(
  httpServer: Server,
  sessionManager: SessionManager,
): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${String(req.headers.host ?? "localhost")}`);
    const match = PATH_PATTERN.exec(url.pathname);

    if (!match?.[1] || !match[2]) return; // Not our route — let other handlers try

    const sessionId = match[1];
    const port = match[2];
    const remainingPath = match[3] ?? "/";

    const origin = req.headers.origin;
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      socket.destroy();
      return;
    }

    const user = authenticateToken(req.headers.cookie);
    if (!user) {
      socket.destroy();
      return;
    }

    const session = sessionManager.getSession(sessionId);
    if (!session) {
      socket.destroy();
      return;
    }
    if (session.userId !== user.id && user.role !== "admin") {
      socket.destroy();
      return;
    }
    if (!session.workspaceIp) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (browserWs) => {
      const targetUrl = `ws://${session.workspaceIp}:${port}${remainingPath}${url.search}`;
      const upstreamWs = new WebSocket(targetUrl);

      upstreamWs.on("open", () => {
        console.log(`[preview-ws] connected ${sessionId} → :${port}${remainingPath}`);
      });

      upstreamWs.on("message", (data, isBinary) => {
        if (browserWs.readyState !== WebSocket.OPEN) return;
        if (browserWs.bufferedAmount > BACKPRESSURE_BYTES) return;
        browserWs.send(data, { binary: isBinary });
      });

      browserWs.on("message", (data, isBinary) => {
        if (upstreamWs.readyState !== WebSocket.OPEN) return;
        if (upstreamWs.bufferedAmount > BACKPRESSURE_BYTES) return;
        upstreamWs.send(data, { binary: isBinary });
      });

      let browserSawPong = false;
      let browserPendingPing = false;
      browserWs.on("pong", () => {
        browserSawPong = true;
        browserPendingPing = false;
      });
      const heartbeat = setInterval(() => {
        if (browserSawPong && browserPendingPing) {
          browserWs.terminate();
          upstreamWs.terminate();
          return;
        }
        if (browserWs.readyState === WebSocket.OPEN) {
          browserPendingPing = true;
          browserWs.ping();
        }
      }, HEARTBEAT_MS);
      const cleanup = (): void => clearInterval(heartbeat);

      upstreamWs.on("close", () => {
        cleanup();
        if (browserWs.readyState === WebSocket.OPEN) {
          browserWs.close();
        }
      });

      upstreamWs.on("error", (err) => {
        console.error(`[preview-ws] upstream error ${sessionId}:${port}: ${err.message}`);
        cleanup();
        if (browserWs.readyState === WebSocket.OPEN) {
          browserWs.close(4003, "Upstream error");
        }
      });

      browserWs.on("close", () => {
        cleanup();
        upstreamWs.close();
      });

      browserWs.on("error", () => {
        cleanup();
        upstreamWs.close();
      });
    });
  });
}
