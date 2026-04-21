import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { SessionManager } from "../services/session-manager.js";
import { authenticateToken } from "../middleware/auth.js";
import { ALLOWED_ORIGINS } from "../index.js";
import { isInLxcSubnet } from "../lib/subnet.js";

const TTYD_PORT = 7681;
/** Drop frames past this point. Bursty ttyd output (e.g. `cat large.log`)
 *  could otherwise buffer tens of MB in Node per slow browser. */
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

    // Origin allowlist — WebSocket upgrades are not subject to CORS preflight
    // but browsers still send Origin. Reject cross-origin opens so a malicious
    // page loaded by a logged-in user can't hijack their terminal via cookie.
    const origin = req.headers.origin;
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      console.log(`[ws] rejected upgrade for ${sessionId}: bad origin ${String(origin)}`);
      socket.destroy();
      return;
    }

    // Authenticate via session cookie
    const user = authenticateToken(req.headers.cookie);
    if (!user) {
      console.log(`[ws] rejected upgrade for ${sessionId}: no valid auth cookie`);
      socket.destroy();
      return;
    }

    // Verify session ownership
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

    if (!session.lxcIp) {
      console.log(`[ws] rejected upgrade for ${sessionId}: no LXC IP`);
      socket.destroy();
      return;
    }

    // Defense-in-depth: session.lxcIp originates from /api/agent/register
    // which already subnet-validates. Re-check before opening a proxy so
    // any future bug that smuggles a non-LXC IP into the DB can't be used
    // to exfiltrate traffic to 127.0.0.1, cloud metadata, or LAN services.
    if (!isInLxcSubnet(session.lxcIp)) {
      console.warn(`[ws] rejected upgrade for ${sessionId}: lxcIp ${session.lxcIp} outside subnet`);
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
  if (!session?.lxcIp) {
    browserWs.close(4004, "Session not found");
    return;
  }

  // Connect to ttyd WebSocket inside the LXC (subprotocol required for PTY handler)
  const ttydUrl = `ws://${session.lxcIp}:${String(TTYD_PORT)}/ws`;
  const ttydWs = new WebSocket(ttydUrl, ["tty"]);

  ttydWs.on("open", () => {
    console.log(`[ws] ttyd connected for session ${sessionId}`);

    // ttyd requires auth handshake before it sends any data
    ttydWs.send(JSON.stringify({ AuthToken: "" }));

    // Also start the terminal via agent control channel
    sessionManager.startTerminal(sessionId);
  });

  // Forward ttyd → browser: only forward output (type 0x30 = ASCII '0').
  // Backpressure: drop if the browser socket has buffered too much —
  // better to lose a few frames than OOM the server.
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

  // Forward binary frames: browser → ttyd (same backpressure guard).
  browserWs.on("message", (data, isBinary) => {
    if (ttydWs.readyState !== WebSocket.OPEN) return;
    if (ttydWs.bufferedAmount > BACKPRESSURE_BYTES) return;
    ttydWs.send(data, { binary: isBinary });
  });

  // Browser-side heartbeat only: catches half-open sockets from NAT rebind /
  // closed laptop lid. We don't ping ttyd — it's reachable over the internal
  // LXC network (sub-ms RTT, TCP keepalive reliable) and its libwebsockets
  // stack has been known not to deliver pong frames through the "tty"
  // subprotocol, which caused this loop to spuriously kill sessions.
  // If ttyd actually dies, its own `close`/`error` events still tear us down.
  //
  // Only terminate after we've observed at least one pong — otherwise a
  // browser that never pongs (older client, network quirk) would be killed
  // even though its TCP connection is fine.
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
