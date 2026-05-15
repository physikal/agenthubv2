import { spawn as nodeSpawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { AuthInbound, AuthOutbound } from "./protocol.js";

export interface ProcessHandle {
  stdoutLines: AsyncIterable<string>;
  stderrLines: AsyncIterable<string>;
  kill: () => void;
  wait: () => Promise<number>;
}

export interface AuthHandlerDeps {
  send: (msg: AuthOutbound) => void;
  spawn?: (command: string) => ProcessHandle;
}

export class AuthHandler {
  private readonly deps: Required<AuthHandlerDeps>;
  private active = new Map<string, { kill: () => void }>();

  constructor(deps: AuthHandlerDeps) {
    this.deps = { spawn: realSpawn, ...deps };
  }

  async handle(msg: AuthInbound): Promise<void> {
    switch (msg.type) {
      case "auth.connect":
        await this.connect(msg);
        return;
      case "auth.cancel":
        this.cancel(msg.tool);
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
    for (const entry of msg.entries) {
      await mkdir(dirname(entry.path), { recursive: true, mode: 0o700 });
      await writeFile(entry.path, Buffer.from(entry.contentsBase64, "base64"), { mode: 0o600 });
    }
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
    this.active.set(msg.tool, { kill: proc.kill });

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
      const done: AuthOutbound = code === 0
        ? { type: "auth.done", tool: msg.tool, ok: true }
        : { type: "auth.done", tool: msg.tool, ok: false, error: formatExitError(code, msg.loginCommand) };
      send(done);
    } finally {
      clearTimeout(timeout);
      this.active.delete(msg.tool);
    }
  }
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
  const proc = nodeSpawn(head, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  if (!proc.stdout || !proc.stderr) throw new Error("subprocess streams unavailable");

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
