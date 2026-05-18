import { spawn as nodeSpawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { AuthInbound, AuthOutbound } from "./protocol.js";

export interface ProcessHandle {
  stdoutLines: AsyncIterable<string>;
  stderrLines: AsyncIterable<string>;
  kill: () => void;
  wait: () => Promise<number>;
  /** Write to the subprocess's stdin. No-op if stdin isn't piped. */
  writeStdin?: (text: string) => void;
}

export interface AuthHandlerDeps {
  send: (msg: AuthOutbound) => void;
  spawn?: (command: string) => ProcessHandle;
  /** Override the path used by the claude-code post-auth hook (tests inject a tempdir). */
  claudeJsonPath?: string;
}

export class AuthHandler {
  private readonly deps: Required<AuthHandlerDeps>;
  private active = new Map<string, { kill: () => void; writeStdin?: (text: string) => void }>();

  constructor(deps: AuthHandlerDeps) {
    this.deps = { spawn: realSpawn, claudeJsonPath: "/home/coder/.claude.json", ...deps };
  }

  async handle(msg: AuthInbound): Promise<void> {
    switch (msg.type) {
      case "auth.connect":
        await this.connect(msg);
        return;
      case "auth.cancel":
        this.cancel(msg.tool);
        return;
      case "auth.input":
        this.writeInput(msg.tool, msg.text);
        return;
      case "auth.disconnect":
        await this.disconnect(msg);
        return;
      case "auth.hydrate":
        await this.hydrate(msg);
        return;
      case "auth.hydrateProbe":
        await this.hydrateProbe(msg);
        return;
    }
  }

  private cancel(tool: string): void {
    const entry = this.active.get(tool);
    if (entry) entry.kill();
  }

  private writeInput(tool: string, text: string): void {
    const entry = this.active.get(tool);
    if (entry?.writeStdin) entry.writeStdin(`${text}\n`);
  }

  private async disconnect(msg: Extract<AuthInbound, { type: "auth.disconnect" }>): Promise<void> {
    try {
      if (msg.logoutCommand) {
        const proc = this.deps.spawn(msg.logoutCommand);
        const drain = async (iter: AsyncIterable<string>): Promise<void> => {
          for await (const _line of iter) { /* drop */ }
        };
        await Promise.all([drain(proc.stdoutLines), drain(proc.stderrLines)]);
        await proc.wait();
      }
      const { unlink } = await import("node:fs/promises");
      for (const p of msg.credentialPaths) {
        await unlink(p).catch(() => undefined);
      }
      this.deps.send({ type: "auth.disconnected", tool: msg.tool, ok: true });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.deps.send({ type: "auth.disconnected", tool: msg.tool, ok: false, error });
    }
  }

  private async hydrate(msg: Extract<AuthInbound, { type: "auth.hydrate" }>): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    let sawClaudeCode = false;
    for (const entry of msg.entries) {
      await mkdir(dirname(entry.path), { recursive: true, mode: 0o700 });
      await writeFile(entry.path, Buffer.from(entry.contentsBase64, "base64"), { mode: 0o600 });
      if (entry.tool === "claude-code") sawClaudeCode = true;
    }
    if (sawClaudeCode) await markClaudeOnboarded(this.deps.claudeJsonPath).catch(() => undefined);
  }

  private async hydrateProbe(msg: Extract<AuthInbound, { type: "auth.hydrateProbe" }>): Promise<void> {
    const { access } = await import("node:fs/promises");
    const missing: Array<{ tool: string; path: string }> = [];
    for (const t of msg.tools) {
      for (const p of t.paths) {
        try { await access(p); } catch { missing.push({ tool: t.tool, path: p }); }
      }
    }
    this.deps.send({ type: "auth.hydrateProbeResult", missing });
  }

  private async connect(msg: Extract<AuthInbound, { type: "auth.connect" }>): Promise<void> {
    const { send } = this.deps;
    const existing = this.active.get(msg.tool);
    if (existing) existing.kill();
    const proc = this.deps.spawn(msg.loginCommand);
    this.active.set(msg.tool, { kill: proc.kill, ...(proc.writeStdin ? { writeStdin: proc.writeStdin } : {}) });

    const consume = async (
      iter: AsyncIterable<string>,
      stream: "stdout" | "stderr",
    ): Promise<void> => {
      for await (const line of iter) {
        send({ type: "auth.line", tool: msg.tool, stream, line });
      }
    };

    const timeout = setTimeout(() => proc.kill(), msg.timeoutSec * 1000);
    try {
      await Promise.all([consume(proc.stdoutLines, "stdout"), consume(proc.stderrLines, "stderr")]);
      const code = await proc.wait();
      // On clean exit, directly capture any credential files that appeared.
      // The fs-watch credential watcher also catches this, but its debounce
      // (and the imminent session teardown after auth.done) races us, so do
      // a direct read here for reliability.
      if (code === 0 && msg.credentialPaths) {
        await this.captureCredentialFiles(msg.tool, msg.credentialPaths);
        if (msg.tool === "claude-code") {
          await markClaudeOnboarded(this.deps.claudeJsonPath).catch(() => undefined);
        }
      }
      const done: AuthOutbound = code === 0
        ? { type: "auth.done", tool: msg.tool, ok: true }
        : { type: "auth.done", tool: msg.tool, ok: false, error: formatExitError(code, msg.loginCommand) };
      send(done);
    } finally {
      clearTimeout(timeout);
      this.active.delete(msg.tool);
    }
  }

  private async captureCredentialFiles(tool: string, paths: string[]): Promise<void> {
    const { readFile, access } = await import("node:fs/promises");
    for (const path of paths) {
      try {
        await access(path);
        const buf = await readFile(path);
        this.deps.send({
          type: "auth.captured",
          tool,
          path,
          contentsBase64: buf.toString("base64"),
        });
      } catch {
        // file absent — nothing to capture for this path
      }
    }
  }
}

const CODER_UID = 1000;
const CODER_GID = 1000;
const CODER_CLAUDE_JSON = "/home/coder/.claude.json";

/**
 * Set `hasCompletedOnboarding: true` in /home/coder/.claude.json. Claude
 * Code's interactive `claude` runs a setup wizard while this sentinel is
 * unset, and the wizard's "Authenticate" step triggers a fresh OAuth flow
 * even when valid creds exist — confusing users who already authed via
 * Integrations. Setting this here makes new sessions skip the wizard and
 * land at "Welcome back".
 *
 * The agent daemon runs as root inside the workspace (HOME=/root), so
 * `~/.claude.json` would resolve to the wrong place. We hard-code the
 * coder user's home — and chown the result to coder:coder so the user
 * shell (which runs as coder) can read it.
 *
 * Tests inject a tempdir path. Production callers omit the arg and get
 * /home/coder/.claude.json.
 *
 * Best-effort: errors are swallowed by callers via .catch(). Worst case
 * the wizard re-runs in the user's session, which is the pre-fix behavior.
 */
export async function markClaudeOnboarded(claudeJsonPath: string = CODER_CLAUDE_JSON): Promise<void> {
  const { mkdir, readFile, writeFile, chown } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  let parsed: Record<string, unknown> = {};
  try {
    const buf = await readFile(claudeJsonPath, "utf8");
    parsed = JSON.parse(buf) as Record<string, unknown>;
  } catch {
    // file missing or unparseable — start from empty object
  }
  if (parsed["hasCompletedOnboarding"] === true) return;
  parsed["hasCompletedOnboarding"] = true;
  await mkdir(dirname(claudeJsonPath), { recursive: true });
  await writeFile(claudeJsonPath, JSON.stringify(parsed, null, 2), { mode: 0o600 });
  // Best-effort chown — fails harmlessly as non-root in tests; production
  // agent runs as root so this gives the user shell read+write access.
  try { await chown(claudeJsonPath, CODER_UID, CODER_GID); } catch { /* non-root or unsupported FS */ }
}

function formatExitError(code: number, command: string): string {
  if (code === 127) {
    const binary = command.trim().split(/\s+/)[0] ?? command;
    return `'${binary}' is not installed in this workspace — install it from the Packages page first.`;
  }
  return `exit ${String(code)}`;
}

function realSpawn(command: string): ProcessHandle {
  // Switch to `coder` user only when daemon runs as root (production).
  // In tests `spawn` is overridden so this branch isn't exercised.
  const argv = process.getuid && process.getuid() === 0
    ? ["su", "-l", "coder", "-c", command]
    : ["sh", "-c", command];
  const head = argv[0];
  if (!head) throw new Error("argv head missing");
  const proc = nodeSpawn(head, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  if (!proc.stdout || !proc.stderr) throw new Error("subprocess streams unavailable");

  // Swallow EPIPE if the subprocess closes stdin before we write to it — happens
  // when the CLI exits after first read (codex --device-auth case where we never
  // need to write but the pipe is open). Without this listener Node logs a noisy
  // "Error [ERR_STREAM_DESTROYED]" trace on stdin.write().
  proc.stdin?.on("error", () => undefined);

  let killed = false;
  return {
    stdoutLines: linesOf(proc.stdout),
    stderrLines: linesOf(proc.stderr),
    kill: () => {
      if (killed) return;
      killed = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 2000).unref();
    },
    wait: () => new Promise((resolve) => proc.on("exit", (code) => resolve(code ?? 1))),
    writeStdin: (text: string): void => {
      if (proc.stdin && !proc.stdin.destroyed) proc.stdin.write(text);
    },
  };
}

async function* linesOf(stream: NodeJS.ReadableStream): AsyncIterable<string> {
  let buf = "";
  for await (const chunk of stream) {
    buf += (chunk as Buffer).toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.length) yield buf;
}

export async function readCredentialFile(path: string): Promise<string> {
  const buf = await readFile(path);
  return buf.toString("base64");
}
