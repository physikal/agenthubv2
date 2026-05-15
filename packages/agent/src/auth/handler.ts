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
      case "auth.hydrate":
      case "auth.hydrateProbe":
        return;
    }
  }

  private cancel(tool: string): void {
    const entry = this.active.get(tool);
    if (entry) entry.kill();
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
        : { type: "auth.done", tool: msg.tool, ok: false, error: `exit ${code}` };
      send(done);
    } finally {
      clearTimeout(timeout);
      this.active.delete(msg.tool);
    }
  }
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
