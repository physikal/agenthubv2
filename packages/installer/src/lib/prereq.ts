import { execFile } from "node:child_process";
import { connect, createServer } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PrereqResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

export async function checkPrereqs(opts: {
  requirePorts: number[];
}): Promise<PrereqResult> {
  const checks: PrereqResult["checks"] = [];

  // 1. Docker daemon reachable.
  try {
    const { stdout } = await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 5_000,
    });
    checks.push({ name: "Docker daemon", ok: true, detail: `v${stdout.trim()}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : "unknown";
    checks.push({ name: "Docker daemon", ok: false, detail: msg ?? "not reachable" });
  }

  // 2. Docker Compose plugin.
  try {
    const { stdout } = await execFileAsync("docker", ["compose", "version", "--short"], {
      timeout: 5_000,
    });
    checks.push({ name: "Docker Compose", ok: true, detail: `v${stdout.trim()}` });
  } catch {
    checks.push({
      name: "Docker Compose",
      ok: false,
      detail: "`docker compose` plugin missing",
    });
  }

  // 3. Required ports free.
  for (const port of opts.requirePorts) {
    const free = await portIsFree(port);
    checks.push({
      name: `Port ${String(port)} free`,
      ok: free,
      detail: free ? "available" : "already in use",
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      // EACCES: the installer runs as a non-root user, which can't bind a
      // privileged port (<1024) — but the stack binds 80/443 via Docker
      // (root), so a bind failure here is NOT a real conflict. Fall back to a
      // connect probe: the port is free unless something already answers on it.
      // (Any other unexpected error → also fall back rather than false-fail.)
      portHasListener(port).then((listening) => resolve(!listening));
    });
    s.once("listening", () => {
      s.close(() => resolve(true));
    });
    s.listen(port, "0.0.0.0");
  });
}

/** True when something is already accepting connections on the port. Used as a
 * privilege-free fallback when we can't bind-test (EACCES on privileged ports
 * as non-root). */
function portHasListener(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const c = connect({ port, host: "127.0.0.1" });
    const finish = (listening: boolean): void => {
      c.destroy();
      resolve(listening);
    };
    c.once("connect", () => finish(true));
    c.once("error", () => finish(false)); // ECONNREFUSED → nothing listening
    c.setTimeout(1000, () => finish(false));
  });
}
