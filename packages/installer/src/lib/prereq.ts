import { execFile } from "node:child_process";
import { createServer } from "node:net";
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

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => {
      s.close(() => resolve(true));
    });
    s.listen(port, "0.0.0.0");
  });
}
