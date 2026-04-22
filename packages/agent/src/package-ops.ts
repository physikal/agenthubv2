/**
 * Install/remove per-user agent CLIs from inside the workspace container.
 * All spawns use argv-array form (no shell) and drop to the coder user
 * (uid 1000) via spawn's `uid`/`gid` options — same ethos as the backup
 * code in `ws-server.ts`.
 *
 * Install prefix is always `/home/coder/.local`. The entrypoint ensures
 * this tree exists and is coder-owned on every boot; the agent also
 * asserts it at startup.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, unlinkSync, rmSync, statSync } from "node:fs";

const CODER_UID = 1000;
const CODER_GID = 1000;
const CODER_HOME = "/home/coder";
const LOCAL_PREFIX = `${CODER_HOME}/.local`;
const LOCAL_BIN = `${LOCAL_PREFIX}/bin`;

const PACKAGE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const BIN_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const NPM_PKG_RE = /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]{0,213}$/;
// https-only, hostname chars limited, path chars kept reasonable.
const URL_RE = /^https:\/\/[A-Za-z0-9.\-]{1,253}(?::\d{1,5})?\/[A-Za-z0-9._\-/?=&%]{0,2048}$/;

/** Mirror of the server-side InstallSpec. Kept in sync manually — no shared package. */
export type InstallSpec =
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
  spec: InstallSpec;
}

export interface PackageOpResult {
  ok: boolean;
  version?: string;
  error?: string;
}

export function validatePackageOpParams(p: PackageOpParams): string | null {
  if (!PACKAGE_ID_RE.test(p.packageId)) return "invalid packageId";
  if (!BIN_NAME_RE.test(p.binName)) return "invalid binName";
  if (!Array.isArray(p.versionCmd) || p.versionCmd.length === 0) {
    return "invalid versionCmd";
  }
  for (const arg of p.versionCmd) {
    if (typeof arg !== "string" || arg.length > 256) return "invalid versionCmd arg";
  }
  switch (p.spec.method) {
    case "npm":
      if (!NPM_PKG_RE.test(p.spec.npmPackage)) return "invalid npmPackage";
      return null;
    case "curl-sh":
      if (!URL_RE.test(p.spec.scriptUrl)) return "invalid scriptUrl";
      if (p.spec.scriptEnv) {
        for (const [k, v] of Object.entries(p.spec.scriptEnv)) {
          if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k)) return "invalid scriptEnv key";
          if (typeof v !== "string" || v.length > 4096) return "invalid scriptEnv value";
        }
      }
      return null;
    case "binary":
      if (!URL_RE.test(p.spec.url)) return "invalid binary url";
      return null;
    default:
      return "unknown install method";
  }
}

export async function installPackage(p: PackageOpParams): Promise<PackageOpResult> {
  const validation = validatePackageOpParams(p);
  if (validation) return { ok: false, error: validation };

  try {
    ensureLocalTree();
    switch (p.spec.method) {
      case "npm":
        await installNpm(p.spec.npmPackage);
        break;
      case "curl-sh":
        await installCurlSh(p.spec.scriptUrl, p.spec.scriptEnv);
        break;
      case "binary":
        await installBinary(p.spec.url, p.spec.stripComponents ?? 0);
        break;
    }

    assertBinaryPresent(p.binName);
    const version = await readVersion(p.versionCmd);
    return version === null
      ? { ok: true }
      : { ok: true, version };
  } catch (err) {
    return { ok: false, error: extractErr(err, "install failed") };
  }
}

export async function removePackage(p: PackageOpParams): Promise<PackageOpResult> {
  const validation = validatePackageOpParams(p);
  if (validation) return { ok: false, error: validation };

  try {
    switch (p.spec.method) {
      case "npm":
        await removeNpm(p.spec.npmPackage);
        break;
      case "curl-sh":
      case "binary":
        await removeFile(`${LOCAL_BIN}/${p.binName}`);
        break;
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: extractErr(err, "remove failed") };
  }
}

// ---------- internal helpers ----------

function ensureLocalTree(): void {
  mkdirSync(LOCAL_BIN, { recursive: true });
  mkdirSync(`${LOCAL_PREFIX}/lib`, { recursive: true });
  // ownership is fixed at entrypoint; we best-effort chown here too in case
  // the agent is asked to install before the entrypoint's chown has run.
  runAsRoot("chown", ["-R", `${String(CODER_UID)}:${String(CODER_GID)}`, LOCAL_PREFIX])
    .catch(() => { /* non-fatal */ });
}

async function installNpm(pkg: string): Promise<void> {
  await runAsCoder(
    "npm",
    ["install", "--global", "--no-audit", "--no-fund", pkg],
    {
      env: {
        HOME: CODER_HOME,
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        NPM_CONFIG_PREFIX: LOCAL_PREFIX,
      },
      timeoutMs: 300_000,
    },
  );
}

async function removeNpm(pkg: string): Promise<void> {
  await runAsCoder(
    "npm",
    ["uninstall", "--global", pkg],
    {
      env: {
        HOME: CODER_HOME,
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        NPM_CONFIG_PREFIX: LOCAL_PREFIX,
      },
      timeoutMs: 120_000,
    },
  );
}

async function installCurlSh(
  url: string,
  scriptEnv?: Record<string, string>,
): Promise<void> {
  const scriptPath = `/tmp/agenthub-install-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}.sh`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${String(res.status)}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length === 0 || body.length > 8 * 1024 * 1024) {
    throw new Error("install script empty or too large");
  }
  writeFileSync(scriptPath, body, { mode: 0o700 });
  try {
    await runAsCoder(
      "bash",
      [scriptPath],
      {
        env: {
          HOME: CODER_HOME,
          PATH: `${LOCAL_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
          PREFIX: LOCAL_PREFIX,
          INSTALL_DIR: LOCAL_BIN,
          XDG_BIN_HOME: LOCAL_BIN,
          ...(scriptEnv ?? {}),
        },
        timeoutMs: 300_000,
      },
    );
  } finally {
    try { unlinkSync(scriptPath); } catch { /* best-effort */ }
  }
}

async function installBinary(url: string, stripComponents: number): Promise<void> {
  const isTar = /\.(tar\.gz|tgz|tar)$/i.test(url);
  const isZip = /\.zip$/i.test(url);
  const scratch = `/tmp/agenthub-install-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}`;
  mkdirSync(scratch, { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${String(res.status)}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length === 0 || body.length > 512 * 1024 * 1024) {
    throw new Error("binary empty or too large");
  }
  try {
    if (isTar) {
      const archive = `${scratch}/archive.tar`;
      writeFileSync(archive, body);
      const args = [
        "-xf", archive,
        "-C", LOCAL_PREFIX,
        ...(stripComponents > 0 ? ["--strip-components", String(stripComponents)] : []),
      ];
      await runAsCoder("tar", args, { timeoutMs: 120_000 });
    } else if (isZip) {
      const archive = `${scratch}/archive.zip`;
      writeFileSync(archive, body);
      await runAsCoder("unzip", ["-oq", archive, "-d", LOCAL_PREFIX], { timeoutMs: 120_000 });
    } else {
      // Treat as a single binary; filename from URL basename.
      const basename = url.split("/").pop() ?? "binary";
      const safeName = basename.replaceAll(/[^A-Za-z0-9._-]/g, "_");
      const target = `${LOCAL_BIN}/${safeName}`;
      writeFileSync(target, body, { mode: 0o755 });
      await runAsRoot(
        "chown",
        [`${String(CODER_UID)}:${String(CODER_GID)}`, target],
      );
    }
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function assertBinaryPresent(binName: string): void {
  try {
    const s = statSync(`${LOCAL_BIN}/${binName}`);
    if (!s.isFile() && !s.isSymbolicLink()) {
      throw new Error(`not a regular file: ${binName}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `install completed but ${binName} not found in ${LOCAL_BIN} (${msg})`,
    );
  }
}

async function readVersion(argv: readonly string[]): Promise<string | null> {
  const [cmd, ...args] = argv;
  if (!cmd) return null;
  try {
    const out = await runAsCoder(cmd, args, {
      env: {
        HOME: CODER_HOME,
        PATH: `${LOCAL_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      },
      timeoutMs: 15_000,
      captureStdout: true,
    });
    const trimmed = out.trim().split("\n")[0]?.trim() ?? "";
    return trimmed.slice(0, 128) || null;
  } catch {
    return null;
  }
}

async function removeFile(path: string): Promise<void> {
  try {
    unlinkSync(path);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw err;
  }
}

interface RunOpts {
  env?: Record<string, string>;
  timeoutMs?: number;
  captureStdout?: boolean;
}

async function runAsCoder(
  cmd: string,
  args: readonly string[],
  opts: RunOpts = {},
): Promise<string> {
  return runSpawn(cmd, args, { ...opts, uid: CODER_UID, gid: CODER_GID });
}

async function runAsRoot(
  cmd: string,
  args: readonly string[],
  opts: RunOpts = {},
): Promise<string> {
  return runSpawn(cmd, args, opts);
}

async function runSpawn(
  cmd: string,
  args: readonly string[],
  opts: RunOpts & { uid?: number; gid?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      stdio: ["ignore", opts.captureStdout ? "pipe" : "ignore", "pipe"],
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
      ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
      if (stdout.length > 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`${cmd} timed out after ${String(opts.timeoutMs)}ms`));
        }, opts.timeoutMs)
      : null;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        const snippet = (stderr.trim() || stdout.trim()).slice(-2000);
        reject(new Error(`${cmd} exited ${String(code)}${snippet ? `: ${snippet}` : ""}`));
      }
    });
  });
}

function extractErr(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message.slice(0, 2000);
  return fallback;
}
