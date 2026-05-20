import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  installPackage,
  removePackage,
  type PackageOpParams,
  type PackageOpResult,
} from "./package-ops.js";
import type { AuthInbound, AuthOutbound } from "./auth/protocol.js";
import type { PackagesInbound, PackagesOutbound } from "./packages-protocol.js";

export interface AgentConfig {
  port: number;
  authToken: string;
}

type InboundMessage =
  | { type: "start" }
  | { type: "upload"; name: string; data: string }
  | { type: "stop" }
  | { type: "package"; op: "install" | "remove"; requestId: string; params: PackageOpParams }
  | AuthInbound
  | PackagesInbound;

type OutboundMessage =
  | { type: "status"; state: string; detail: string }
  | { type: "ready"; hostname: string }
  | { type: "error"; message: string }
  | {
      type: "package-result";
      requestId: string;
      ok: boolean;
      version?: string;
      error?: string;
    }
  | AuthOutbound
  | PackagesOutbound;

export class AgentServer {
  private wss: WebSocketServer;
  private client: WebSocket | null = null;
  private readonly authToken: string;
  private sessionStarted = false;
  private authRouter: ((msg: AuthInbound) => Promise<void>) | null = null;

  public setAuthRouter(fn: (msg: AuthInbound) => Promise<void>): void {
    this.authRouter = fn;
  }

  private packagesRouter: ((msg: PackagesInbound) => Promise<void>) | null = null;

  public setPackagesRouter(fn: (msg: PackagesInbound) => Promise<void>): void {
    this.packagesRouter = fn;
  }

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
    if (typeof msg.type === "string" && msg.type.startsWith("auth.")) {
      if (this.authRouter) void this.authRouter(msg as AuthInbound);
      return;
    }
    if (typeof msg.type === "string" && msg.type.startsWith("essentials.")) {
      if (this.packagesRouter) void this.packagesRouter(msg as PackagesInbound);
      return;
    }
    switch (msg.type) {
      case "start":
        this.startSession();
        break;
      case "upload":
        this.handleUpload(msg.name, msg.data);
        break;
      case "stop":
        break;
      case "package":
        void this.handlePackage(msg.op, msg.requestId, msg.params);
        break;
    }
  }

  /**
   * Install or remove a per-user agent CLI into /home/coder/.local. Structured
   * params only — the server picks the install method from the catalog and
   * passes a typed spec, so no raw shell crosses the WS boundary.
   */
  private async handlePackage(
    op: "install" | "remove",
    requestId: string,
    params: PackageOpParams,
  ): Promise<void> {
    let result: PackageOpResult;
    try {
      result = op === "install"
        ? await installPackage(params)
        : await removePackage(params);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      result = { ok: false, error: msg };
    }
    const msg: OutboundMessage = { type: "package-result", requestId, ok: result.ok };
    if (result.version !== undefined) msg.version = result.version;
    if (result.error !== undefined) msg.error = result.error;
    this.send(msg);
  }

  private startSession(): void {
    if (this.sessionStarted) {
      this.send({ type: "status", state: "active", detail: "terminal ready" });
      return;
    }
    this.sessionStarted = true;
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

  send(msg: OutboundMessage): void {
    if (this.client?.readyState === 1) {
      this.client.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.wss.close();
  }

  isConnected(): boolean {
    return this.client?.readyState === 1;
  }
}
