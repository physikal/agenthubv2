import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, existsSync, copyFileSync, chmodSync, chownSync, writeFileSync, readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import WebSocket from "ws";
import { db, schema } from "../db/index.js";
import type { Session, SessionStatus } from "../db/schema.js";
import type { ProxmoxClient } from "./proxmox.js";
import type { ContainerPool } from "./pool.js";

/** Ping the agent every 30s to detect idle NAT/firewall drops that
 *  kill the TCP without a clean close — same pattern terminal-proxy.ts
 *  applies to the browser side. The agent uses the ws library's default
 *  server behavior, which auto-responds to protocol ping frames with pong. */
const AGENT_HEARTBEAT_MS = 30_000;

const ACTIVE_STATUSES: SessionStatus[] = [
  "creating", "starting", "waiting_login", "active", "waiting_input", "idle",
];

// Copy SSH key to writable location with correct perms (k8s secret mounts are group-readable)
const SSH_KEY_SRC = "/etc/ssh-keys/id_ed25519";
const SSH_KEY_PATH = "/tmp/pve-ssh-key";
if (existsSync(SSH_KEY_SRC) && !existsSync(SSH_KEY_PATH)) {
  copyFileSync(SSH_KEY_SRC, SSH_KEY_PATH);
  chmodSync(SSH_KEY_PATH, 0o600);
}

const NODE_IPS: Record<string, string> = {
  pve05: "192.168.5.100",
  pve06: "192.168.5.101",
  pve07: "192.168.5.102",
};

function resolveNodeIp(node: string): string {
  const ip = NODE_IPS[node];
  if (!ip) throw new Error(`Unknown PVE node: ${node}`);
  return ip;
}

/** Resolve the host-side path for a user's home dir based on PVE node. */
function resolveHomePath(node: string, userId: string): string {
  if (node === "pve06") {
    return `/rpool/agenthub-homes/${userId}`;
  }
  return `/mnt/agenthub-homes/${userId}`;
}

const SSH_ARGS = ["-i", SSH_KEY_PATH, "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"];

const execFileAsync = promisify(execFile);

/**
 * Run a command over SSH on a PVE node without blocking the event loop.
 *
 * Previously used `execFileSync` which blocked all HTTP requests, WebSocket
 * upgrades, and timer callbacks for up to 15 s per call — and up to 45 s
 * total for the bind-mount retry loop. Now awaits normally.
 */
async function sshExec(nodeIp: string, cmd: string, timeoutMs = 15_000): Promise<void> {
  await execFileAsync("ssh", [...SSH_ARGS, `root@${nodeIp}`, cmd], { timeout: timeoutMs });
}

interface AgentConnection {
  sessionId: string;
  ws: WebSocket;
  lxcIp: string;
}

interface CreateSessionInput {
  name: string;
  userId: string;
  repo?: string | undefined;
  prompt?: string | undefined;
}

export class SessionManager {
  private readonly proxmox: ProxmoxClient;
  private readonly templateVmid: number;
  private readonly agentPort: number;
  private readonly agentToken: string;
  private readonly agents = new Map<string, AgentConnection>();
  private readonly pool: ContainerPool | null;

  constructor(proxmox: ProxmoxClient, templateVmid: number, pool?: ContainerPool) {
    this.proxmox = proxmox;
    this.templateVmid = templateVmid;
    this.agentPort = 9876;
    this.agentToken = process.env["AGENT_AUTH_TOKEN"] ?? "";
    this.pool = pool ?? null;
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
      if (!session.lxcNode || !session.lxcVmid || !session.lxcIp) {
        this.updateSession(session.id, {
          status: "failed",
          statusDetail: "server restarted before provisioning completed",
          endedAt: new Date(),
        });
        continue;
      }

      try {
        const status = await this.proxmox.getLxcStatus(session.lxcNode, session.lxcVmid);
        if (status.status !== "running") {
          console.log(`[session] VMID ${String(session.lxcVmid)} not running, marking completed`);
          this.updateSession(session.id, {
            status: "completed",
            statusDetail: "container stopped",
            endedAt: new Date(),
          });
          continue;
        }

        const ip = await this.connectWithIpRefresh(
          session.id,
          session.lxcNode,
          session.lxcVmid,
          session.lxcIp,
        );
        console.log(`[session] reconnected to VMID ${String(session.lxcVmid)} (${session.name}) at ${ip}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        // Container is running but agent connection failed — keep session alive.
        // The agent will restart via systemd and the terminal proxy (ttyd) works
        // independently. Don't destroy a running container over a transient failure.
        console.warn(
          `[session] agent unreachable for VMID ${String(session.lxcVmid)} (${session.name}), keeping session active: ${msg}`,
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
        statusDetail: "Provisioning container...",
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

    void this.provisionAndStart(session);

    return session;
  }

  private async provisionAndStart(session: Session): Promise<void> {
    try {
      this.updateSession(session.id, {
        status: "creating",
        statusDetail: "Waiting for container...",
      });

      const pooled = await this.waitForPoolContainer(60_000);
      if (!pooled) {
        throw new Error("No containers available — pool empty after 60s");
      }

      const { node, vmid, agentToken: containerToken } = pooled;
      console.log(`[session] claimed container VMID ${String(vmid)} on ${node}`);

      // Verify the container actually exists and is running before proceeding
      try {
        const status = await this.proxmox.getLxcStatus(node, vmid);
        if (status.status !== "running") {
          throw new Error(`Container VMID ${String(vmid)} is ${status.status}, expected running`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        throw new Error(`Claimed container VMID ${String(vmid)} is not available: ${msg}`);
      }

      // Bind the pool container's pre-written AGENT_TOKEN to this session so
      // agentAuthMiddleware can validate MCP calls by token alone — no
      // cross-session X-Vmid trust required.
      this.updateSession(session.id, {
        status: "starting",
        statusDetail: "Configuring storage...",
        lxcNode: node,
        lxcVmid: vmid,
        agentToken: containerToken,
      });

      // Ensure user's persistent home directory exists (via NFS mount in pod)
      const userId = session.userId ?? "default";
      if (!/^[a-f0-9-]{36}$/.test(userId)) {
        throw new Error("Invalid userId format");
      }
      const podHomePath = `/homes/${userId}`;
      if (!existsSync(podHomePath)) {
        mkdirSync(podHomePath, { recursive: true });
        chownSync(podHomePath, 101000, 101000);
        console.log(`[session] created home directory for user ${userId}`);
      }

      // Write rclone config + backup script if B2 is configured
      this.writeBackupConfig(userId, podHomePath);

      // Write default OpenCode config if not present
      this.writeOpenCodeConfig(podHomePath);

      // Write MCP deploy server config for Claude Code. Pass the session's
      // per-container agent token so the MCP server auths via the primary
      // `sessions.agentToken` path — the legacy shared-token fallback keeps
      // working if this is empty.
      this.writeMcpConfig(podHomePath, containerToken);

      // Write MiniMax CLI config if admin has set minimax_api_key
      this.writeMmxConfig(podHomePath);

      // Write preview env vars (session ID + public URL)
      this.writePreviewEnv(session.id, podHomePath);

      // Stop container to reconfigure bind mount
      this.updateSession(session.id, {
        statusDetail: "Mounting user storage...",
      });

      try {
        await this.proxmox.stopLxc(node, vmid);
      } catch {
        // Container may already be stopped
      }

      // Wait for stop with retries for transient errors
      await this.proxmox.waitForStop(node, vmid);

      // Clear any lingering lock + set bind mount via SSH
      const hostHomePath = resolveHomePath(node, userId);
      const nodeIp = resolveNodeIp(node);

      // Retry bind mount up to 3 times (handles transient locks)
      let bindMountSet = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await sshExec(nodeIp, `pct unlock ${String(vmid)} 2>/dev/null; pct set ${String(vmid)} -mp0 ${hostHomePath},mp=/home/coder`);
          console.log(`[session] bind mount set for VMID ${String(vmid)}: ${hostHomePath} → /home/coder`);
          bindMountSet = true;
          break;
        } catch (err) {
          if (attempt === 2) {
            const msg = err instanceof Error ? err.message : "unknown";
            throw new Error(`Failed to set bind mount after 3 attempts: ${msg}`);
          }
          console.log(`[session] bind mount attempt ${String(attempt + 1)} failed, retrying...`);
          await sleep(3_000);
        }
      }

      if (!bindMountSet) {
        throw new Error("Failed to set bind mount");
      }

      // Start container with bind mount — agent will re-register with new IP
      this.updateSession(session.id, {
        statusDetail: "Starting container...",
      });

      const ipPromise = this.pool!.waitForRegistration(vmid);
      const startTask = await this.proxmox.startLxc(node, vmid);
      await this.proxmox.waitForTask(node, startTask);

      // Wait for agent to re-register (provides IP via POST /api/agent/register)
      const ip = await ipPromise;
      this.updateSession(session.id, { lxcIp: ip });

      console.log(`[session] container VMID ${String(vmid)} restarted with storage, ip: ${ip}`);

      // Connect to agent (restarts with container)
      this.updateSession(session.id, {
        statusDetail: "Connecting to agent...",
      });

      await this.connectToAgent(session.id, ip, this.agentToken);

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

  private async waitForPoolContainer(
    timeoutMs: number,
  ): Promise<{ vmid: number; node: string; ip: string | null; agentToken: string } | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const container = this.pool?.claim();
      if (container?.ip) return container;
      await sleep(3_000);
    }
    return null;
  }

  /**
   * Connect to the agent, refreshing the session's lxc_ip from Proxmox
   * if the stored one fails. DHCP lease renewals leave the DB with a
   * stale IP, which used to pin sessions in "agent reconnecting" forever.
   *
   * Returns the IP that actually succeeded.
   */
  private async connectWithIpRefresh(
    sessionId: string,
    node: string,
    vmid: number,
    storedIp: string,
    timeoutMs = 60_000,
  ): Promise<string> {
    try {
      await this.connectToAgent(sessionId, storedIp, this.agentToken, timeoutMs);
      return storedIp;
    } catch (firstErr) {
      const freshIp = await this.proxmox.getLxcIp(node, vmid);
      if (!freshIp || freshIp === storedIp) throw firstErr;

      console.log(
        `[session] lxc_ip drifted for VMID ${String(vmid)}: ${storedIp} → ${freshIp}, retrying`,
      );
      this.updateSession(sessionId, { lxcIp: freshIp });
      await this.connectToAgent(sessionId, freshIp, this.agentToken, timeoutMs);
      return freshIp;
    }
  }

  private async connectToAgent(
    sessionId: string,
    ip: string,
    token: string,
    timeoutMs = 60_000,
  ): Promise<void> {
    const url = `ws://${ip}:${String(this.agentPort)}?token=${token}`;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const ws = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => {
            this.agents.set(sessionId, { sessionId, ws, lxcIp: ip });
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
          code?: number;
          message?: string;
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
      } catch {
        // ignore parse errors from forwarded binary data
      }
    });

    // Heartbeat: ping the agent on an interval and terminate if a pong
    // doesn't come back before the next tick. Without this, an idle NAT
    // or firewall between Swarm and the LXC subnet silently drops the
    // TCP connection — the server's WS only noticed on the next send,
    // triggering an endless cleanup→reconnect loop under Dokploy.
    //
    // Only terminate after we've observed at least one pong, to ride
    // out the brief window between open and the first response.
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

    // Swallow post-open errors — every error is followed by a close event
    // which runs the cleanup; we just need a handler attached so Node
    // doesn't treat it as unhandled.
    ws.on("error", (err: Error) => {
      console.warn(`[session] agent ws error for ${sessionId}: ${err.message}`);
    });
  }

  private cleanupIfCompleted(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (!session) return;

    if (session.status === "completed" || session.status === "failed") return;

    console.log(
      `[session] agent disconnected for ${sessionId} (status: ${session.status}), verifying container`,
    );

    if (!session.lxcNode || !session.lxcVmid) {
      this.updateSession(sessionId, {
        status: "completed",
        statusDetail: "agent lost (no container info)",
        endedAt: new Date(),
      });
      return;
    }

    void this.proxmox
      .getLxcStatus(session.lxcNode, session.lxcVmid)
      .then((status) => {
        if (status.status !== "running") {
          console.log(
            `[session] VMID ${String(session.lxcVmid)} is ${status.status}, marking completed`,
          );
          this.updateSession(sessionId, {
            status: "completed",
            statusDetail: "container stopped",
            endedAt: new Date(),
          });
        } else {
          console.log(
            `[session] VMID ${String(session.lxcVmid)} still running, will retry agent connection`,
          );
          void this.connectWithIpRefresh(
            sessionId,
            session.lxcNode!,
            session.lxcVmid!,
            session.lxcIp!,
            30_000,
          ).catch(() => {
            // Container is running but agent won't connect — keep session alive.
            // The terminal (ttyd) works independently of the agent.
            console.warn(
              `[session] agent reconnect failed for ${sessionId}, container still running — keeping idle`,
            );
            this.updateSession(sessionId, {
              status: "idle",
              statusDetail: "agent reconnecting",
            });
          });
        }
      })
      .catch(() => {
        console.log(
          `[session] cannot reach VMID ${String(session.lxcVmid)}, marking completed`,
        );
        this.updateSession(sessionId, {
          status: "completed",
          statusDetail: "container unreachable",
          endedAt: new Date(),
        });
      });
  }

  getAgentConnection(sessionId: string): AgentConnection | undefined {
    return this.agents.get(sessionId);
  }

  startTerminal(sessionId: string): void {
    const agent = this.agents.get(sessionId);
    if (!agent) return;
    agent.ws.send(JSON.stringify({ type: "start" }));
  }

  private writeBackupConfig(userId: string, podHomePath: string): void {
    const rows = db
      .select()
      .from(schema.userCredentials)
      .where(eq(schema.userCredentials.userId, userId))
      .all();

    const configStr = rows[0]?.backupConfig;
    if (!configStr) return;

    let config: { b2KeyId: string; b2AppKey: string; b2Bucket: string };
    try {
      config = JSON.parse(configStr) as typeof config;
    } catch {
      return;
    }

    const userRows = db
      .select({ username: schema.users.username })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .all();
    const username = userRows[0]?.username ?? userId;

    const rcloneDir = `${podHomePath}/.config/rclone`;
    mkdirSync(rcloneDir, { recursive: true });
    try { chownSync(`${podHomePath}/.config`, 101000, 101000); } catch { /* */ }
    chownSync(rcloneDir, 101000, 101000);

    const rcloneConf = `[b2]\ntype = b2\naccount = ${config.b2KeyId}\nkey = ${config.b2AppKey}\n`;
    writeFileSync(`${rcloneDir}/rclone.conf`, rcloneConf, { mode: 0o600 });
    chownSync(`${rcloneDir}/rclone.conf`, 101000, 101000);

    const binDir = `${podHomePath}/.local/bin`;
    mkdirSync(binDir, { recursive: true });
    try { chownSync(`${podHomePath}/.local`, 101000, 101000); } catch { /* */ }
    chownSync(binDir, 101000, 101000);

    const bucket = `b2:${config.b2Bucket}/${username}`;
    const script = `#!/bin/bash
# Auto-generated by AgentHub
BUCKET="${bucket}"
case "\${1:-}" in
  save)    rclone sync /home/coder "$BUCKET" --exclude ".cache/**" --exclude "**/node_modules/**" --exclude ".local/**" -P ;;
  restore) rclone copy "$BUCKET" /home/coder -P ;;
  status)  rclone size "$BUCKET" ;;
  *)       echo "Usage: backup save|restore|status" ;;
esac
`;
    writeFileSync(`${binDir}/backup`, script, { mode: 0o755 });
    chownSync(`${binDir}/backup`, 101000, 101000);

    console.log(`[session] wrote rclone config + backup script for user ${username}`);
  }

  private writeOpenCodeConfig(podHomePath: string): void {
    const configDir = `${podHomePath}/.config/opencode`;
    const configPath = `${configDir}/opencode.json`;
    if (existsSync(configPath)) return; // Don't overwrite user's config

    mkdirSync(configDir, { recursive: true });
    try { chownSync(`${podHomePath}/.config`, 101000, 101000); } catch { /* */ }
    chownSync(configDir, 101000, 101000);

    const config = {
      $schema: "https://opencode.ai/config.json",
      model: "minimax/MiniMax-M2.7",
      provider: {
        minimax: {
          npm: "@ai-sdk/openai-compatible",
          name: "MiniMax",
          options: {
            baseURL: "https://api.minimax.io/v1",
          },
          models: {
            "MiniMax-M2.7": {
              name: "MiniMax M2.7",
            },
          },
        },
      },
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o644 });
    chownSync(configPath, 101000, 101000);
    console.log("[session] wrote default OpenCode config (MiniMax M2.7)");
  }

  private writeMcpConfig(podHomePath: string, sessionAgentToken: string): void {
    // Claude Code MCP scopes (mirroring `claude mcp add --scope ...`):
    //   - local    → ~/.claude.json at projects[<cwd>].mcpServers
    //                (matches cwd EXACTLY; does not inherit into subdirs)
    //   - user     → ~/.claude.json at top-level mcpServers
    //                (applies in every project / working directory)
    //   - project  → <project>/.mcp.json (shared via git)
    //
    // The previous code wrote to the `local` scope at /home/coder, so the
    // tool was invisible anywhere else (e.g. /home/coder/my-project).
    // Writing to `user` scope fixes that.
    const mcpServer = {
      type: "stdio",
      command: "/usr/bin/node",
      args: ["/opt/agenthub-agent/mcp-deploy.js"],
      env: {
        PORTAL_URL: process.env["AGENT_PORTAL_URL"] ?? "http://192.168.5.110:30080",
        AGENT_TOKEN: sessionAgentToken,
        AGENT_AUTH_TOKEN: process.env["AGENT_AUTH_TOKEN"] ?? "",
      },
    };

    this.writeUserScopedMcpServer(podHomePath, "agenthub-deploy", mcpServer);
    this.stripProjectScopedMcpServer(podHomePath, "agenthub-deploy");
    this.stripSettingsJsonMcpServer(podHomePath, "agenthub-deploy");

    console.log("[session] wrote MCP deploy server config (user scope in ~/.claude.json)");
  }

  /** Merge a single MCP server entry into ~/.claude.json at top-level mcpServers. */
  private writeUserScopedMcpServer(
    podHomePath: string,
    name: string,
    server: Record<string, unknown>,
  ): void {
    const path = `${podHomePath}/.claude.json`;

    let config: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        config = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      } catch {
        // Start fresh if corrupt — better to overwrite garbage than crash.
      }
    }

    const mcpServers = (config["mcpServers"] ?? {}) as Record<string, unknown>;
    mcpServers[name] = server;
    config["mcpServers"] = mcpServers;

    writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
    chownSync(path, 101000, 101000);
  }

  /** Remove a now-duplicate project-scoped entry from ~/.claude.json. */
  private stripProjectScopedMcpServer(podHomePath: string, name: string): void {
    const path = `${podHomePath}/.claude.json`;
    if (!existsSync(path)) return;

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch {
      return;
    }

    const projects = config["projects"] as Record<string, Record<string, unknown>> | undefined;
    const coderProject = projects?.["/home/coder"];
    const mcpServers = coderProject?.["mcpServers"] as Record<string, unknown> | undefined;
    if (!mcpServers || !(name in mcpServers)) return;

    delete mcpServers[name];
    writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
    chownSync(path, 101000, 101000);
  }

  /**
   * Remove the (wrong) entry the previous fix attempt wrote to
   * ~/.claude/settings.json — that file isn't where Claude Code looks for
   * MCP servers, and leaving an `mcpServers` key there at best confuses
   * Claude Code settings parsing.
   */
  private stripSettingsJsonMcpServer(podHomePath: string, name: string): void {
    const path = `${podHomePath}/.claude/settings.json`;
    if (!existsSync(path)) return;

    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch {
      return;
    }

    const mcpServers = settings["mcpServers"] as Record<string, unknown> | undefined;
    if (!mcpServers || !(name in mcpServers)) return;

    delete mcpServers[name];
    if (Object.keys(mcpServers).length === 0) {
      delete settings["mcpServers"];
    } else {
      settings["mcpServers"] = mcpServers;
    }

    writeFileSync(path, JSON.stringify(settings, null, 2), { mode: 0o600 });
    chownSync(path, 101000, 101000);
  }

  private writeMmxConfig(podHomePath: string): void {
    const configDir = `${podHomePath}/.mmx`;
    const configPath = `${configDir}/config.json`;
    if (existsSync(configPath)) return;

    const rows = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "minimax_api_key"))
      .all();

    const apiKey = rows[0]?.value;
    if (!apiKey) return;

    mkdirSync(configDir, { recursive: true });
    chownSync(configDir, 101000, 101000);
    chmodSync(configDir, 0o700);

    const config = { api_key: apiKey, region: "global" };

    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    chownSync(configPath, 101000, 101000);
    console.log("[session] wrote MiniMax CLI config");
  }

  private writePreviewEnv(sessionId: string, podHomePath: string): void {
    const envPath = `${podHomePath}/.agenthub-env`;
    const publicUrl = process.env["AGENTHUB_PUBLIC_URL"]
      ?? process.env["AGENT_PORTAL_URL"]
      ?? "https://agenthub.physhlab.com";

    const content = [
      `export AGENTHUB_SESSION_ID="${sessionId}"`,
      `export AGENTHUB_URL="${publicUrl}"`,
      "",
    ].join("\n");

    writeFileSync(envPath, content, { mode: 0o644 });
    chownSync(envPath, 101000, 101000);
    console.log("[session] wrote preview env vars");
  }

  async endSession(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) return;

    // Already completed — don't try to destroy again
    if (session.status === "completed" || session.status === "failed") return;

    const agent = this.agents.get(sessionId);
    if (agent) {
      try { agent.ws.send(JSON.stringify({ type: "stop" })); } catch { /* */ }
      agent.ws.close();
      this.agents.delete(sessionId);
    }

    if (session.lxcNode && session.lxcVmid) {
      try {
        await this.proxmox.stopLxc(session.lxcNode, session.lxcVmid);
        await sleep(2_000);
        await this.proxmox.destroyLxc(session.lxcNode, session.lxcVmid);
        console.log(`[session] destroyed container VMID ${String(session.lxcVmid)}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        console.error(`[session] failed to destroy VMID ${String(session.lxcVmid)}: ${msg}`);
      }
    }

    this.updateSession(sessionId, {
      status: "completed",
      endedAt: new Date(),
    });
  }

  getSession(id: string): Session | undefined {
    const rows = db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, id))
      .all();
    return rows[0];
  }

  listSessions(): Session[] {
    return db
      .select()
      .from(schema.sessions)
      .orderBy(schema.sessions.createdAt)
      .all();
  }

  listSessionsForUser(userId: string): Session[] {
    return db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, userId))
      .orderBy(schema.sessions.createdAt)
      .all();
  }

  deleteSession(id: string): void {
    db.delete(schema.sessions)
      .where(eq(schema.sessions.id, id))
      .run();
  }

  private updateSession(
    id: string,
    updates: Partial<{
      status: SessionStatus;
      statusDetail: string;
      lxcVmid: number;
      lxcNode: string;
      lxcIp: string;
      agentToken: string;
      endedAt: Date;
    }>,
  ): void {
    db.update(schema.sessions)
      .set(updates)
      .where(eq(schema.sessions.id, id))
      .run();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
