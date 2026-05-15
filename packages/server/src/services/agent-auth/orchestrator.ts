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
  error?: string;
  expiresAt?: string;
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

export interface ConnectArgs {
  userId: string;
  toolId: string;
  onEvent: (e: OrchestratorEvent) => void;
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

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

    let captured: { path: string; contentsBase64: string } | null = null;
    let urlEmitted = false;
    const urlRegex = tool.urlPattern;

    const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      session.agent.on("message", (raw) => {
        const msg = raw as { type: string } & Record<string, unknown>;
        if (msg["type"] === "auth.line") {
          const line = String(msg["line"] ?? "");
          if (!urlEmitted) {
            const m = line.match(urlRegex);
            if (m) {
              urlEmitted = true;
              const matchedUrl = m[0];
              args.onEvent({ phase: "awaiting-url", url: matchedUrl });
              args.onEvent({ phase: "awaiting-callback" });
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
      await this.deps.sessions.destroy(session.sessionId);
    }
  }
}
