import { watch, readFile, mkdir } from "node:fs/promises";
import { dirname, basename } from "node:path";
import type { AuthOutbound } from "./protocol.js";

export interface WatcherDeps {
  send: (msg: AuthOutbound) => void;
  debounceMs?: number;
  tools: Array<{ tool: string; paths: string[] }>;
}

export class CredentialWatcher {
  private readonly deps: Required<WatcherDeps>;
  private controllers: AbortController[] = [];
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(deps: WatcherDeps) {
    this.deps = { debounceMs: 5000, ...deps };
  }

  start(): void {
    for (const t of this.deps.tools) {
      for (const p of t.paths) {
        this.watchOne(t.tool, p);
      }
    }
  }

  stop(): void {
    for (const c of this.controllers) c.abort();
    this.controllers = [];
    for (const tm of this.timers.values()) clearTimeout(tm);
    this.timers.clear();
  }

  private watchOne(tool: string, path: string): void {
    const ctrl = new AbortController();
    this.controllers.push(ctrl);
    void (async () => {
      try {
        const dir = dirname(path);
        const file = basename(path);
        await mkdir(dir, { recursive: true });
        const watcher = watch(dir, { signal: ctrl.signal });
        for await (const ev of watcher) {
          if (ev.filename !== file) continue;
          this.scheduleEmit(tool, path);
        }
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name !== "AbortError") {
          console.warn(`[cred-watcher] ${path} failed: ${(err as Error).message}`);
        }
      }
    })();
  }

  private scheduleEmit(tool: string, path: string): void {
    const existing = this.timers.get(path);
    if (existing !== undefined) clearTimeout(existing);
    const tm = setTimeout(() => {
      this.timers.delete(path);
      readFile(path)
        .then((buf) => {
          this.deps.send({
            type: "auth.captured",
            tool,
            path,
            contentsBase64: buf.toString("base64"),
          });
        })
        .catch(() => {
          // File vanished between event and read — ignore.
        });
    }, this.deps.debounceMs);
    this.timers.set(path, tm);
  }
}
