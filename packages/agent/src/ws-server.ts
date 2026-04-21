import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";

export interface AgentConfig {
  port: number;
  authToken: string;
}

type InboundMessage =
  | { type: "start" }
  | { type: "upload"; name: string; data: string }
  | { type: "stop" };

type OutboundMessage =
  | { type: "status"; state: string; detail: string }
  | { type: "ready"; hostname: string }
  | { type: "error"; message: string };

export class AgentServer {
  private wss: WebSocketServer;
  private client: WebSocket | null = null;
  private readonly authToken: string;
  private sessionStarted = false;

  constructor(config: AgentConfig) {
    this.authToken = config.authToken;
    this.wss = new WebSocketServer({ port: config.port });
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const token = url.searchParams.get("token");

    if (token !== this.authToken) {
      ws.close(4001, "Unauthorized");
      return;
    }

    if (this.client) {
      this.client.close(4002, "Replaced by new connection");
    }
    this.client = ws;

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as InboundMessage;
        this.handleMessage(msg);
      } catch {
        this.send({ type: "error", message: "Invalid message format" });
      }
    });

    ws.on("close", () => {
      if (this.client === ws) this.client = null;
    });
  }

  private handleMessage(msg: InboundMessage): void {
    switch (msg.type) {
      case "start":
        this.startSession();
        break;
      case "upload":
        this.handleUpload(msg.name, msg.data);
        break;
      case "stop":
        break;
    }
  }

  private startSession(): void {
    if (this.sessionStarted) {
      this.send({ type: "status", state: "active", detail: "terminal ready" });
      return;
    }
    this.sessionStarted = true;

    // Credentials live on persistent storage at /home/coder/.claude/
    // No injection needed — they survive across sessions via bind mount
    this.send({ type: "status", state: "active", detail: "terminal ready" });
  }

  private handleUpload(name: string, base64Data: string): void {
    const dir = "/tmp/uploads";
    mkdirSync(dir, { recursive: true });
    const safeName = name.replaceAll(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 255);
    const path = `${dir}/${safeName}`;
    writeFileSync(path, Buffer.from(base64Data, "base64"));
    this.send({ type: "status", state: "active", detail: `uploaded: ${path}` });
  }

  private send(msg: OutboundMessage): void {
    if (this.client?.readyState === 1) {
      this.client.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.wss.close();
  }
}
