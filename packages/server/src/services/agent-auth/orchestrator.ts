import { getTool } from "./registry.js";
import { agentCredentialPath, CREDENTIAL_SECRET_NAME } from "./paths.js";
import type { SecretStore } from "../secrets/index.js";
import type { AuditAction } from "./audit.js";

export type OrchestratorPhase =
  | "preparing"
  | "awaiting-url"
  | "awaiting-callback"
  | "captured"
  | "done"
  | "error";

export interface OrchestratorEvent {
  phase: OrchestratorPhase;
  url?: string;
  /** One-time / device code printed by the CLI (e.g. "34J7-3WML1"). */
  code?: string;
  error?: string;
  expiresAt?: string;
  /** True if the tool expects the user to paste a code back via stdin. */
  acceptsCodeInput?: boolean;
}

export interface AgentChannel {
  send(msg: unknown): void;
  on(ev: "message", cb: (msg: unknown) => void): this;
}

export interface AuthHelperSession {
  sessionId: string;
  agent: AgentChannel;
}

export interface SessionsAPI {
  createAuthHelper(userId: string): Promise<AuthHelperSession>;
  destroy(sessionId: string): Promise<void>;
}

export interface AuditEntryArg {
  userId: string;
  action: AuditAction;
  toolId: string;
  sessionId?: string;
  ok: boolean;
  error?: string;
}

export interface OrchestratorDeps {
  sessions: SessionsAPI;
  store: SecretStore;
  audit: (entry: AuditEntryArg) => Promise<void>;
}

export type StatusResult = {
  id: string;
  status: "connected" | "disconnected";
  expiresAt?: string;
};

export interface ConnectArgs {
  userId: string;
  toolId: string;
  onEvent: (e: OrchestratorEvent) => void;
}

export class Orchestrator {
  /** Active in-flight connect flows keyed by `${userId}|${toolId}`. Used by
   * `relayInput` to send paste-back codes to the right auth-helper. */
  private readonly active = new Map<string, AgentChannel>();

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Pipe text to the active auth-helper's subprocess stdin. Used when the
   * CLI is waiting for the user to paste an OAuth confirmation code (e.g.
   * `claude auth login`). No-op if no flow is active for this (user, tool). */
  relayInput(args: { userId: string; toolId: string; text: string }): void {
    const channel = this.active.get(`${args.userId}|${args.toolId}`);
    if (!channel) return;
    channel.send({ type: "auth.input", tool: args.toolId, text: args.text });
  }

  async connect(args: ConnectArgs): Promise<void> {
    const tool = getTool(args.toolId);
    if (!tool) {
      args.onEvent({ phase: "error", error: `unknown tool: ${args.toolId}` });
      await this.deps.audit({
        userId: args.userId,
        action: "connect",
        toolId: args.toolId,
        ok: false,
        error: "unknown tool",
      });
      return;
    }

    args.onEvent({ phase: "preparing" });
    const session = await this.deps.sessions.createAuthHelper(args.userId);
    const activeKey = `${args.userId}|${args.toolId}`;
    this.active.set(activeKey, session.agent);

    let captured: { path: string; contentsBase64: string } | null = null;
    let urlEmitted = false;
    let codeEmitted = false;
    const urlRegex = tool.urlPattern;
    const codeRegex = tool.codePattern;

    const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      session.agent.on("message", (raw) => {
        const msg = raw as { type: string } & Record<string, unknown>;
        if (msg["type"] === "auth.line") {
          // Strip ANSI color escapes — codex wraps the device code in
          // \x1b[94m...\x1b[0m, and the trailing 'm' before the code breaks
          // \b word boundaries in codePattern.
          const line = stripAnsi(String(msg["line"] ?? ""));
          if (!urlEmitted) {
            const m = line.match(urlRegex);
            if (m) {
              urlEmitted = true;
              const matchedUrl = m[0];
              const evt: OrchestratorEvent = { phase: "awaiting-url", url: matchedUrl };
              if (tool.acceptsCodeInput) evt.acceptsCodeInput = true;
              args.onEvent(evt);
              args.onEvent({ phase: "awaiting-callback" });
            }
          }
          if (!codeEmitted && codeRegex) {
            const cm = line.match(codeRegex);
            if (cm) {
              codeEmitted = true;
              args.onEvent({ phase: "awaiting-callback", code: cm[0] });
            }
          }
        } else if (msg["type"] === "auth.captured") {
          captured = {
            path: String(msg["path"]),
            contentsBase64: String(msg["contentsBase64"]),
          };
          args.onEvent({ phase: "captured" });
        } else if (msg["type"] === "auth.done") {
          const ok = Boolean(msg["ok"]);
          const errorField = msg["error"];
          resolve(
            ok
              ? { ok: true }
              : {
                  ok: false,
                  error: typeof errorField === "string" ? errorField : "login failed",
                },
          );
        }
      });
    });

    session.agent.send({
      type: "auth.connect",
      tool: tool.id,
      loginCommand: tool.loginCommand,
      urlPattern: urlRegex.source,
      timeoutSec: tool.loginTimeoutSec,
    });

    const result = await done;
    const effective = result.ok && captured === null
      ? { ok: false, error: "login exited 0 but no credential file captured" }
      : result;

    try {
      if (effective.ok && captured !== null) {
        const cap = captured as { path: string; contentsBase64: string };
        const path = agentCredentialPath(args.userId, tool.id);
        const contentsBuf = Buffer.from(cap.contentsBase64, "base64");
        const contentsStr = contentsBuf.toString("utf8");
        await this.deps.store.setSecrets(path, {
          [CREDENTIAL_SECRET_NAME]: contentsStr,
          filePath: cap.path,
        });
        const expiry = tool.expiryParser?.(contentsStr) ?? null;
        const doneEvent: OrchestratorEvent = { phase: "done" };
        if (expiry) doneEvent.expiresAt = expiry.toISOString();
        args.onEvent(doneEvent);
        await this.deps.audit({
          userId: args.userId,
          action: "connect",
          toolId: tool.id,
          sessionId: session.sessionId,
          ok: true,
        });
        await this.deps.audit({
          userId: args.userId,
          action: "capture",
          toolId: tool.id,
          sessionId: session.sessionId,
          ok: true,
        });
      } else {
        const errEvent: OrchestratorEvent = { phase: "error" };
        if (effective.error) errEvent.error = effective.error;
        args.onEvent(errEvent);
        const auditEntry: AuditEntryArg = {
          userId: args.userId,
          action: "connect",
          toolId: tool.id,
          sessionId: session.sessionId,
          ok: false,
        };
        if (effective.error) auditEntry.error = effective.error;
        await this.deps.audit(auditEntry);
      }
    } finally {
      this.active.delete(activeKey);
      await this.deps.sessions.destroy(session.sessionId);
    }
  }

  async disconnect(args: { userId: string; toolId: string }): Promise<void> {
    const tool = getTool(args.toolId);
    if (!tool) return;
    const session = await this.deps.sessions.createAuthHelper(args.userId);
    try {
      const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
        session.agent.on("message", (raw) => {
          const m = raw as { type: string; ok?: boolean; error?: string };
          if (m.type === "auth.disconnected") {
            const ok = Boolean(m.ok);
            const out: { ok: boolean; error?: string } = { ok };
            if (typeof m.error === "string") out.error = m.error;
            resolve(out);
          }
        });
      });
      const disconnectMsg: {
        type: "auth.disconnect";
        tool: string;
        credentialPaths: string[];
        logoutCommand?: string;
      } = {
        type: "auth.disconnect",
        tool: tool.id,
        credentialPaths: tool.credentialPaths,
      };
      if (tool.logoutCommand) disconnectMsg.logoutCommand = tool.logoutCommand;
      session.agent.send(disconnectMsg);
      const result = await done;
      const credPath = agentCredentialPath(args.userId, tool.id);
      await this.deps.store.deletePath(credPath).catch(() => undefined);
      const auditEntry: AuditEntryArg = {
        userId: args.userId,
        action: "disconnect",
        toolId: tool.id,
        sessionId: session.sessionId,
        ok: result.ok,
      };
      if (result.error) auditEntry.error = result.error;
      await this.deps.audit(auditEntry);
    } finally {
      await this.deps.sessions.destroy(session.sessionId);
    }
  }

  async status(args: { userId: string; toolId: string }): Promise<StatusResult> {
    const tool = getTool(args.toolId);
    if (!tool) return { id: args.toolId, status: "disconnected" };
    const credPath = agentCredentialPath(args.userId, tool.id);
    const cred = await this.deps.store.getSecret(credPath, CREDENTIAL_SECRET_NAME);
    if (!cred) return { id: tool.id, status: "disconnected" };
    const expiry = tool.expiryParser?.(cred) ?? null;
    const out: StatusResult = { id: tool.id, status: "connected" };
    if (expiry) out.expiresAt = expiry.toISOString();
    return out;
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}
