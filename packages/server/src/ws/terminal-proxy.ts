import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { SessionManager } from "../services/session-manager.js";
import { authenticateToken } from "../middleware/auth.js";
import { isOriginAllowed } from "../middleware/origin.js";

const TTYD_PORT = 7681;
/** Drop frames past this point. Bursty ttyd output (e.g. `cat large.log`) could
 *  otherwise buffer tens of MB in Node per slow browser. */
const BACKPRESSURE_BYTES = 1_000_000;
/** Ping every 30s, terminate after one missed pong. Half-open TCP sockets
 *  (NAT rebind, closed laptop lid) otherwise live for the OS keepalive
 *  window (~2h on Linux), leaking ttyd and proxy handles. */
const HEARTBEAT_MS = 30_000;

export function setupTerminalProxy(
  httpServer: Server,
  sessionManager: SessionManager,
): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${String(req.headers.host ?? "localhost")}`);
    const match = /^\/ws\/sessions\/([^/]+)\/terminal$/.exec(url.pathname);

    if (!match?.[1]) {
      socket.destroy();
      return;
    }

    const sessionId = match[1];

    const origin = req.headers.origin;
    if (!isOriginAllowed(origin, req.headers.host)) {
      console.log(`[ws] rejected upgrade for ${sessionId}: bad origin ${String(origin)}`);
      socket.destroy();
      return;
    }

    const user = authenticateToken(req.headers.cookie);
    if (!user) {
      console.log(`[ws] rejected upgrade for ${sessionId}: no valid auth cookie`);
      socket.destroy();
      return;
    }

    const session = sessionManager.getSession(sessionId);
    if (!session) {
      console.log(`[ws] rejected upgrade for ${sessionId}: session not found`);
      socket.destroy();
      return;
    }
    if (session.userId !== user.id && user.role !== "admin") {
      console.log(`[ws] rejected upgrade for ${sessionId}: not owner`);
      socket.destroy();
      return;
    }
    if (!session.workspaceIp) {
      console.log(`[ws] rejected upgrade for ${sessionId}: workspace not ready`);
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (browserWs) => {
      handleBrowserConnection(browserWs, sessionId, sessionManager);
    });
  });
}

function handleBrowserConnection(
  browserWs: WebSocket,
  sessionId: string,
  sessionManager: SessionManager,
): void {
  const session = sessionManager.getSession(sessionId);
  if (!session?.workspaceIp) {
    browserWs.close(4004, "Session not found");
    return;
  }

  const ttydUrl = `ws://${session.workspaceIp}:${String(TTYD_PORT)}/ws`;
  const ttydWs = new WebSocket(ttydUrl, ["tty"]);

  ttydWs.on("open", () => {
    console.log(`[ws] ttyd connected for session ${sessionId}`);
    ttydWs.send(JSON.stringify({ AuthToken: "" }));
    sessionManager.startTerminal(sessionId);
  });

  ttydWs.on("message", (data, isBinary) => {
    if (browserWs.readyState !== WebSocket.OPEN) return;
    if (!isBinary) return;

    const buf = Buffer.from(data as ArrayBuffer);
    if (buf.length < 2) return;

    // ttyd prefixes server→client messages with ASCII type byte:
    // '0' (0x30) = output, '1' (0x31) = title, '2' (0x32) = preferences
    if (buf[0] === 0x30) {
      if (browserWs.bufferedAmount > BACKPRESSURE_BYTES) return;
      browserWs.send(buf.subarray(1), { binary: true });
    }
  });

  browserWs.on("message", (data, isBinary) => {
    if (ttydWs.readyState !== WebSocket.OPEN) return;
    if (ttydWs.bufferedAmount > BACKPRESSURE_BYTES) return;
    ttydWs.send(data, { binary: isBinary });
  });

  let browserSawPong = false;
  let browserPendingPing = false;
  browserWs.on("pong", () => {
    browserSawPong = true;
    browserPendingPing = false;
  });

  const heartbeat = setInterval(() => {
    if (browserSawPong && browserPendingPing) {
      console.log(`[ws] terminating ${sessionId}: browser missed heartbeat`);
      browserWs.terminate();
      ttydWs.terminate();
      return;
    }
    if (browserWs.readyState === WebSocket.OPEN) {
      browserPendingPing = true;
      browserWs.ping();
    }
  }, HEARTBEAT_MS);

  const cleanup = (): void => clearInterval(heartbeat);

  ttydWs.on("close", () => {
    cleanup();
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.close(4003, "ttyd disconnected");
    }
  });

  ttydWs.on("error", (err) => {
    console.error(`[ws] ttyd error for ${sessionId}: ${err.message}`);
    cleanup();
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.close(4003, "ttyd error");
    }
  });

  browserWs.on("close", () => {
    cleanup();
    console.log(`[ws] browser disconnected from ${sessionId}`);
    ttydWs.close();
  });

  browserWs.on("error", () => {
    cleanup();
    ttydWs.close();
  });
}
