import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AgentConfig {
  port: number;
  authToken: string;
}

export interface BackupParams {
  b2KeyId: string;
  b2AppKey: string;
  b2Bucket: string;
  /** Subdirectory under the B2 bucket (typically the username). */
  subdir: string;
  /** Optional ISO timestamp for point-in-time restore. */
  snapshotAt?: string;
}

type InboundMessage =
  | { type: "start" }
  | { type: "upload"; name: string; data: string }
  | { type: "stop" }
  | { type: "backup"; op: "save" | "restore" | "size"; requestId: string; params: BackupParams };

type OutboundMessage =
  | { type: "status"; state: string; detail: string }
  | { type: "ready"; hostname: string }
  | { type: "error"; message: string }
  | {
      type: "backup-result";
      requestId: string;
      ok: boolean;
      bytes?: number;
      fileCount?: number;
      error?: string;
    };

// Characters allowed in B2 credentials / bucket names. Fail-closed to stop
// newline-injection into rclone.conf (which would inject a fake section).
const B2_FIELD_RE = /^[A-Za-z0-9_\-./]{1,256}$/;

function validateBackupParams(p: BackupParams): string | null {
  if (!B2_FIELD_RE.test(p.b2KeyId)) return "invalid b2KeyId";
  if (!B2_FIELD_RE.test(p.b2AppKey)) return "invalid b2AppKey";
  if (!B2_FIELD_RE.test(p.b2Bucket)) return "invalid b2Bucket";
  if (!/^[A-Za-z0-9_\-]{1,64}$/.test(p.subdir)) return "invalid subdir";
  if (p.snapshotAt && !/^\d{4}-\d{2}-\d{2}T[\d:.+-]{8,}Z?$/.test(p.snapshotAt)) return "invalid snapshotAt";
  return null;
}

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
      case "backup":
        void this.handleBackup(msg.op, msg.requestId, msg.params);
        break;
    }
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

  /**
   * Run rclone against /home/coder for save/restore. Config is written to a
   * fresh /tmp directory and wiped on exit so even a process-crash-mid-backup
   * doesn't leak credentials across sessions.
   */
  private async handleBackup(
    op: "save" | "restore" | "size",
    requestId: string,
    params: BackupParams,
  ): Promise<void> {
    const validation = validateBackupParams(params);
    if (validation) {
      this.send({ type: "backup-result", requestId, ok: false, error: validation });
      return;
    }

    const confDir = `/tmp/rclone-${requestId}`;
    mkdirSync(confDir, { recursive: true });
    const confPath = `${confDir}/rclone.conf`;
    writeFileSync(
      confPath,
      `[b2]\ntype = b2\naccount = ${params.b2KeyId}\nkey = ${params.b2AppKey}\n`,
      { mode: 0o600 },
    );

    const remote = `b2:${params.b2Bucket}/${params.subdir}`;
    const home = "/home/coder";

    try {
      if (op === "save") {
        await execFileAsync(
          "rclone",
          [
            "--config", confPath,
            "sync", home, remote,
            "--exclude", ".cache/**",
            "--exclude", "**/node_modules/**",
            "--exclude", ".local/**",
            "--stats=0",
          ],
          { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
        );
        const size = await this.rcloneSize(confPath, remote);
        this.send({
          type: "backup-result",
          requestId,
          ok: true,
          ...(size?.bytes !== undefined ? { bytes: size.bytes } : {}),
          ...(size?.count !== undefined ? { fileCount: size.count } : {}),
        });
      } else if (op === "restore") {
        const args = ["--config", confPath, "copy", remote, home, "--stats=0"];
        if (params.snapshotAt) args.push("--b2-versions-at", params.snapshotAt);
        await execFileAsync("rclone", args, { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
        this.send({ type: "backup-result", requestId, ok: true });
      } else if (op === "size") {
        const size = await this.rcloneSize(confPath, remote);
        this.send({
          type: "backup-result",
          requestId,
          ok: true,
          ...(size?.bytes !== undefined ? { bytes: size.bytes } : {}),
          ...(size?.count !== undefined ? { fileCount: size.count } : {}),
        });
      }
    } catch (err) {
      const msg = this.extractExecError(err, `rclone ${op} failed`);
      this.send({ type: "backup-result", requestId, ok: false, error: msg });
    } finally {
      try {
        rmSync(confDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }

  private async rcloneSize(
    confPath: string,
    remote: string,
  ): Promise<{ bytes: number; count: number } | null> {
    try {
      const { stdout } = await execFileAsync(
        "rclone",
        ["--config", confPath, "size", remote, "--json"],
        { timeout: 30_000 },
      );
      return JSON.parse(stdout) as { bytes: number; count: number };
    } catch {
      return null;
    }
  }

  private extractExecError(err: unknown, fallback: string): string {
    const e = err as { stderr?: string | Buffer; stdout?: string | Buffer; code?: number | string; message?: string };
    const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString("utf-8") ?? "";
    const stdout = typeof e.stdout === "string" ? e.stdout : e.stdout?.toString("utf-8") ?? "";
    const text = (stderr.trim() || stdout.trim()).slice(-2000);
    if (text) return text;
    if (e.code !== undefined) return `${fallback} (exit ${String(e.code)})`;
    return e.message ?? fallback;
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
