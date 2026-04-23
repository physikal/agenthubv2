import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import WebSocket from "ws";
import { db, schema } from "../db/index.js";
import type { Session, SessionStatus } from "../db/schema.js";
import type {
  ProvisionerDriver,
  WorkspaceRef,
} from "./provisioner/types.js";
import { mintTokenForUser } from "./providers/github-app.js";

/**
 * Ping the agent every 30s to detect idle NAT/firewall drops that kill the
 * TCP without a clean close. Same pattern terminal-proxy.ts applies to the
 * browser side.
 */
const AGENT_HEARTBEAT_MS = 30_000;
const AGENT_PORT = 9876;

const ACTIVE_STATUSES: SessionStatus[] = [
  "creating", "starting", "waiting_login", "active", "waiting_input", "idle",
];

interface AgentConnection {
  sessionId: string;
  ws: WebSocket;
  ip: string;
}

interface CreateSessionInput {
  name: string;
  userId: string;
  repo?: string | undefined;
  prompt?: string | undefined;
}

export interface BackupParams {
  b2KeyId: string;
  b2AppKey: string;
  b2Bucket: string;
  subdir: string;
  snapshotAt?: string;
}

export interface BackupResult {
  ok: boolean;
  bytes?: number;
  fileCount?: number;
  error?: string;
}

interface PendingBackup {
  resolve: (r: BackupResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Mirror of the agent's InstallSpec. Redefined here so the server package
 * doesn't depend on @agenthub/agent — same duplication pattern used for
 * BackupParams. */
export type PackageInstallSpec =
  | { method: "npm"; npmPackage: string }
  | {
      method: "curl-sh";
      scriptUrl: string;
      scriptEnv?: Record<string, string>;
    }
  | { method: "binary"; url: string; stripComponents?: number };

export interface PackageOpParams {
  packageId: string;
  binName: string;
  versionCmd: readonly string[];
  spec: PackageInstallSpec;
}

export interface PackageOpResult {
  ok: boolean;
  version?: string;
  error?: string;
}

interface PendingPackageOp {
  resolve: (r: PackageOpResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SessionManager {
  private readonly provisioner: ProvisionerDriver;
  private readonly workspaceImage: string;
  private readonly portalUrl: string;
  private readonly agents = new Map<string, AgentConnection>();
  /** requestId → pending backup */
  private readonly pendingBackups = new Map<string, PendingBackup>();
  /** requestId → pending package install/remove */
  private readonly pendingPackageOps = new Map<string, PendingPackageOp>();

  constructor(opts: {
    provisioner: ProvisionerDriver;
    workspaceImage: string;
    portalUrl: string;
  }) {
    this.provisioner = opts.provisioner;
    this.workspaceImage = opts.workspaceImage;
    this.portalUrl = opts.portalUrl;
  }

  async reconnectActiveSessions(): Promise<void> {
    const active = db
      .select()
      .from(schema.sessions)
      .where(inArray(schema.sessions.status, ACTIVE_STATUSES))
      .all();

    if (active.length === 0) return;

    console.log(`[session] found ${String(active.length)} active session(s), attempting reconnect`);

    for (const session of active) {
      if (!session.workspaceId || !session.providerId || !session.workspaceHost) {
        this.updateSession(session.id, {
          status: "failed",
          statusDetail: "server restarted before provisioning completed",
          endedAt: new Date(),
        });
        continue;
      }

      const ref: WorkspaceRef = {
        workspaceId: session.workspaceId,
        providerId: session.providerId,
        host: session.workspaceHost,
      };

      try {
        const status = await this.provisioner.status(ref);
        if (status.state !== "running") {
          console.log(
            `[session] workspace ${session.workspaceId} is ${status.state}, marking completed`,
          );
          this.updateSession(session.id, {
            status: "completed",
            statusDetail: `workspace ${status.state}`,
            endedAt: new Date(),
          });
          continue;
        }

        const ip = status.ip ?? session.workspaceIp;
        if (!ip) {
          this.updateSession(session.id, {
            status: "idle",
            statusDetail: "workspace has no reachable address",
          });
          continue;
        }

        if (ip !== session.workspaceIp) {
          this.updateSession(session.id, { workspaceIp: ip });
        }

        await this.connectToAgent(session.id, ip, session.agentToken ?? "");
        console.log(`[session] reconnected workspace ${session.workspaceId} (${session.name}) at ${ip}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        console.warn(
          `[session] agent unreachable for ${session.workspaceId} (${session.name}), keeping session active: ${msg}`,
        );
        this.updateSession(session.id, {
          status: "idle",
          statusDetail: "agent reconnecting",
        });
      }
    }
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const id = randomUUID();
    const agentToken = randomUUID();

    const rows = db
      .insert(schema.sessions)
      .values({
        id,
        name: input.name,
        userId: input.userId,
        status: "creating",
        statusDetail: "Provisioning workspace...",
        agentToken,
        repo: input.repo ?? null,
        prompt: input.prompt ?? null,
        createdAt: new Date(),
      })
      .returning()
      .all();

    const session = rows[0];
    if (!session) {
      throw new Error("Failed to create session record");
    }

    void this.provisionAndStart(session, agentToken);

    return session;
  }

  private async provisionAndStart(
    session: Session,
    agentToken: string,
  ): Promise<void> {
    try {
      this.updateSession(session.id, {
        status: "creating",
        statusDetail: "Creating workspace...",
      });

      const workspaceId = randomUUID();
      const userId = session.userId ?? "default";
      if (!/^[a-f0-9-]{36}$/.test(userId) && userId !== "default") {
        throw new Error("Invalid userId format");
      }

      const volumeName = `agenthub-home-${userId}`;

      // If the user has a GitHub App installation, mint a fresh 1-hour
      // installation token and inject it as GITHUB_TOKEN. The agent daemon
      // picks this up on boot and writes a ~/.gitconfig URL-rewrite rule
      // so every `git clone`/`git push` inside the workspace "just works"
      // without per-session PAT management. Failures are non-fatal — the
      // workspace boots without the token; legacy PAT flow still applies.
      const env: Record<string, string> = {
        PORTAL_URL: this.portalUrl,
        AGENT_TOKEN: agentToken,
        AGENT_PORT: String(AGENT_PORT),
        SESSION_ID: session.id,
        SESSION_NAME: session.name,
      };
      try {
        const gh = await mintTokenForUser(userId);
        if (gh) {
          env["GITHUB_TOKEN"] = gh.token;
          env["GITHUB_ACCOUNT_LOGIN"] = gh.accountLogin;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[session ${session.id}] skipping GitHub token injection: ${msg}`);
      }

      const ref = await this.provisioner.create({
        workspaceId,
        userId,
        image: this.workspaceImage,
        volumeName,
        displayName: session.name,
        env,
      });

      this.updateSession(session.id, {
        workspaceId: ref.workspaceId,
        providerId: ref.providerId,
        workspaceHost: ref.host,
        status: "starting",
        statusDetail: "Waiting for workspace...",
      });

      const ip = await this.provisioner.waitForIp(ref);
      this.updateSession(session.id, { workspaceIp: ip });

      this.updateSession(session.id, {
        statusDetail: "Connecting to agent...",
      });

      await this.connectToAgent(session.id, ip, agentToken);

      this.updateSession(session.id, {
        status: "active",
        statusDetail: "terminal ready",
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown provisioning error";
      console.error(`[session] provisioning failed: ${message}`);
      this.updateSession(session.id, {
        status: "failed",
        statusDetail: message,
      });
    }
  }

  private async connectToAgent(
    sessionId: string,
    ip: string,
    token: string,
    timeoutMs = 60_000,
  ): Promise<void> {
    const url = `ws://${ip}:${String(AGENT_PORT)}?token=${encodeURIComponent(token)}`;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const ws = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => {
            this.agents.set(sessionId, { sessionId, ws, ip });
            this.setupAgentListeners(sessionId, ws);
            resolve();
          });
          ws.once("error", (err) => reject(err));
          setTimeout(() => reject(new Error("Connection timeout")), 5_000);
        });
        return;
      } catch {
        await sleep(3_000);
      }
    }
    throw new Error("Timed out connecting to agent");
  }

  private setupAgentListeners(sessionId: string, ws: WebSocket): void {
    ws.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type: string;
          state?: string;
          detail?: string;
        };

        if (msg.type === "status" && msg.state) {
          this.updateSession(sessionId, {
            status: msg.state as SessionStatus,
            statusDetail: msg.detail ?? "",
          });
        }

        if (msg.type === "exited") {
          void this.endSession(sessionId);
        }

        if (msg.type === "backup-result") {
          const r = msg as unknown as {
            type: "backup-result";
            requestId: string;
            ok: boolean;
            bytes?: number;
            fileCount?: number;
            error?: string;
          };
          const pending = this.pendingBackups.get(r.requestId);
          if (pending) {
            this.pendingBackups.delete(r.requestId);
            clearTimeout(pending.timer);
            const result: BackupResult = { ok: r.ok };
            if (r.bytes !== undefined) result.bytes = r.bytes;
            if (r.fileCount !== undefined) result.fileCount = r.fileCount;
            if (r.error !== undefined) result.error = r.error;
            pending.resolve(result);
          }
        }

        if (msg.type === "package-result") {
          const r = msg as unknown as {
            type: "package-result";
            requestId: string;
            ok: boolean;
            version?: string;
            error?: string;
          };
          const pending = this.pendingPackageOps.get(r.requestId);
          if (pending) {
            this.pendingPackageOps.delete(r.requestId);
            clearTimeout(pending.timer);
            const result: PackageOpResult = { ok: r.ok };
            if (r.version !== undefined) result.version = r.version;
            if (r.error !== undefined) result.error = r.error;
            pending.resolve(result);
          }
        }
      } catch {
        // ignore parse errors
      }
    });

    let sawPong = false;
    let pendingPing = false;
    ws.on("pong", () => {
      sawPong = true;
      pendingPing = false;
    });

    const heartbeat = setInterval(() => {
      if (sawPong && pendingPing) {
        console.log(`[session] terminating ${sessionId}: agent missed heartbeat`);
        ws.terminate();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        pendingPing = true;
        try {
          ws.ping();
        } catch {
          // ws.ping can throw if socket closed between readyState check and call
        }
      }
    }, AGENT_HEARTBEAT_MS);

    ws.on("close", () => {
      clearInterval(heartbeat);
      this.agents.delete(sessionId);
      this.cleanupIfCompleted(sessionId);
    });

    ws.on("error", (err: Error) => {
      console.warn(`[session] agent ws error for ${sessionId}: ${err.message}`);
    });
  }

  private cleanupIfCompleted(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (!session) return;
    if (session.status === "completed" || session.status === "failed") return;
    if (!session.workspaceId || !session.providerId || !session.workspaceHost) {
      this.updateSession(sessionId, {
        status: "completed",
        statusDetail: "agent lost (no workspace info)",
        endedAt: new Date(),
      });
      return;
    }

    const ref: WorkspaceRef = {
      workspaceId: session.workspaceId,
      providerId: session.providerId,
      host: session.workspaceHost,
    };

    void this.provisioner
      .status(ref)
      .then((status) => {
        if (status.state !== "running") {
          this.updateSession(sessionId, {
            status: "completed",
            statusDetail: `workspace ${status.state}`,
            endedAt: new Date(),
          });
        } else {
          this.updateSession(sessionId, {
            status: "idle",
            statusDetail: "agent disconnected",
          });
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "unknown";
        console.warn(`[session] status check failed for ${sessionId}: ${msg}`);
      });
  }

  async endSession(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) return;
    if (session.status === "completed" || session.status === "failed") return;

    const agent = this.agents.get(sessionId);
    if (agent) {
      try { agent.ws.close(); } catch { /* ignore */ }
      this.agents.delete(sessionId);
    }

    if (session.workspaceId && session.providerId && session.workspaceHost) {
      const ref: WorkspaceRef = {
        workspaceId: session.workspaceId,
        providerId: session.providerId,
        host: session.workspaceHost,
      };
      try {
        // keepVolume=true so the user's /home/coder persists across sessions.
        await this.provisioner.destroy(ref, { keepVolume: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        console.warn(`[session] destroy failed for ${sessionId}: ${msg}`);
      }
    }

    this.updateSession(sessionId, {
      status: "completed",
      statusDetail: "session ended",
      endedAt: new Date(),
    });
  }

  getSession(sessionId: string): Session | undefined {
    return db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .get();
  }

  listSessions(): Session[] {
    return db.select().from(schema.sessions).all();
  }

  listSessionsForUser(userId: string): Session[] {
    return db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, userId))
      .all();
  }

  getAgentConnection(sessionId: string): AgentConnection | undefined {
    return this.agents.get(sessionId);
  }

  /** Tell the agent inside the workspace to spawn the terminal / long-running shell. */
  startTerminal(sessionId: string): void {
    const agent = this.agents.get(sessionId);
    if (!agent) return;
    try {
      agent.ws.send(JSON.stringify({ type: "start" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.warn(`[session] startTerminal send failed for ${sessionId}: ${msg}`);
    }
  }

  deleteSession(sessionId: string): void {
    db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run();
  }

  /**
   * Send a backup request to the agent inside the workspace for one of the
   * user's active sessions. Agent runs rclone against /home/coder and sends
   * back a {type: "backup-result", requestId, ok, ...} message which is
   * correlated here by requestId.
   */
  async backupViaAgent(
    userId: string,
    op: "save" | "restore" | "size",
    params: BackupParams,
    timeoutMs = 360_000,
  ): Promise<BackupResult> {
    const session = this.findActiveSessionForUser(userId);
    if (!session) {
      throw new Error(
        "No active workspace session — start a session first so the agent can reach /home/coder.",
      );
    }
    const agent = this.agents.get(session.id);
    if (!agent) {
      throw new Error("Workspace agent not currently connected");
    }

    const requestId = randomUUID();
    return new Promise<BackupResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingBackups.delete(requestId);
        reject(new Error(`agent backup ${op} timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);
      this.pendingBackups.set(requestId, { resolve, reject, timer });
      try {
        agent.ws.send(JSON.stringify({ type: "backup", op, requestId, params }));
      } catch (err) {
        this.pendingBackups.delete(requestId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Install or remove a per-user package via the agent running inside the
   * user's active workspace. Same request/response correlation as
   * backupViaAgent — an agent restart between send and reply leaves the
   * request to time out rather than hang.
   */
  async packageViaAgent(
    userId: string,
    op: "install" | "remove",
    params: PackageOpParams,
    timeoutMs = 300_000,
  ): Promise<PackageOpResult> {
    const session = this.findActiveSessionForUser(userId);
    if (!session) {
      throw new Error(
        "No active workspace session — start a session so the agent can install packages into /home/coder/.local.",
      );
    }
    const agent = this.agents.get(session.id);
    if (!agent) {
      throw new Error("Workspace agent not currently connected");
    }

    const requestId = randomUUID();
    return new Promise<PackageOpResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPackageOps.delete(requestId);
        reject(new Error(`agent package ${op} timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);
      this.pendingPackageOps.set(requestId, { resolve, reject, timer });
      try {
        agent.ws.send(
          JSON.stringify({ type: "package", op, requestId, params }),
        );
      } catch (err) {
        this.pendingPackageOps.delete(requestId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private findActiveSessionForUser(userId: string): Session | undefined {
    return this.listSessionsForUser(userId).find((s) =>
      ACTIVE_STATUSES.includes(s.status),
    );
  }

  private updateSession(
    sessionId: string,
    patch: Partial<Session>,
  ): void {
    db.update(schema.sessions)
      .set(patch)
      .where(eq(schema.sessions.id, sessionId))
      .run();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
