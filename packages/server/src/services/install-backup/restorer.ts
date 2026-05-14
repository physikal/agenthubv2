import { spawn } from "child_process";
import { mkdtempSync, readFileSync, copyFileSync, existsSync, rmSync, createReadStream } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { parseManifest } from "./manifest.js";
import { computeConflicts } from "./conflict.js";
import type { BundleManifest, ConflictReport, RestoreSource, B2Config } from "./types.js";
import { b2Pull, b2List } from "./b2-client.js";
import { parseFilenameTimestamp } from "./retention.js";

const REPO_DIR = "/repo";
const DB_PATH = "/data/agenthub.db";

export interface ResolvedBundle {
  localPath: string;
  manifest: BundleManifest;
  stagingDir: string;
}

export interface RestoreInputs {
  b2Config: B2Config | null; // null = local-only mode
  currentEnvEncryptionKey: string;
  userCount: number;
  secretCount: number;
  activeSessionCount: number;
}

export async function resolveSource(
  source: RestoreSource,
  b2Config: B2Config | null,
): Promise<string> {
  if (source.kind === "local") return source.path;

  if (!b2Config) {
    throw new Error("restore source requires B2 credentials; configure B2 first");
  }

  const tmp = mkdtempSync(join(tmpdir(), `restore-${randomUUID()}-`));
  const localCopy = join(tmp, "bundle.tar.gz");

  if (source.kind === "b2-url") {
    // Parse b2://bucket/path → use as remote ref directly
    // Strip the b2://bucket/ prefix for the rclone call
    const m = /^b2:\/\/[^/]+\/(.+)$/.exec(source.url);
    if (!m) throw new Error(`invalid b2:// URL: ${source.url}`);
    const remotePath = m[1] ?? "";
    await b2Pull(b2Config, remotePath, localCopy);
    return localCopy;
  }

  // b2-snapshot
  const filenames = await b2List(b2Config);
  const bundles = filenames
    .filter((f) => parseFilenameTimestamp(f) !== null)
    .sort();
  if (bundles.length === 0) throw new Error("no bundles found in B2 bucket");

  let chosen: string;
  if (source.snapshot === "latest") {
    const last = bundles[bundles.length - 1] ?? "";
    chosen = last;
  } else {
    const found = bundles.find((f) => f.includes(source.snapshot));
    if (found === undefined) {
      throw new Error(`no bundle matches snapshot ${source.snapshot}`);
    }
    chosen = found;
  }
  await b2Pull(b2Config, chosen, localCopy);
  return localCopy;
}

export async function extractAndValidate(bundlePath: string): Promise<ResolvedBundle> {
  const stagingDir = mkdtempSync(join(tmpdir(), `restore-staging-${randomUUID()}-`));

  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-C", stagingDir, "-xzf", bundlePath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar extract failed (exit ${code}): ${stderr}`));
    });
  });

  // Validate manifest
  const manifestPath = join(stagingDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw new Error("bundle missing manifest.json");
  }
  const manifest = parseManifest(readFileSync(manifestPath, "utf8"));

  // Validate all expected files present
  for (const f of ["env", "agenthub.db", "infisical.sql"]) {
    if (!existsSync(join(stagingDir, f))) {
      rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(`bundle missing ${f}`);
    }
  }

  return { localPath: bundlePath, manifest, stagingDir };
}

function readEnvEncryptionKey(envContent: string): string {
  const m = /^INFISICAL_ENCRYPTION_KEY=(.+)$/m.exec(envContent);
  return m ? (m[1] ?? "").trim() : "";
}

export function buildConflictReport(
  bundle: ResolvedBundle,
  inputs: RestoreInputs,
): ConflictReport {
  const bundleEnv = readFileSync(join(bundle.stagingDir, "env"), "utf8");
  return computeConflicts({
    userCount: inputs.userCount,
    secretCount: inputs.secretCount,
    activeSessionCount: inputs.activeSessionCount,
    currentEnvEncryptionKey: inputs.currentEnvEncryptionKey,
    bundleEnvEncryptionKey: readEnvEncryptionKey(bundleEnv),
  });
}

export async function applyRestore(
  bundle: ResolvedBundle,
  composeProject: string,
  onLine?: (line: string) => void,
): Promise<void> {
  const log = (l: string): void => { if (onLine) onLine(l); };

  // 1. Stop the writable services (NOT infisical-postgres or redis)
  log("[restore] stopping agenthub services...");
  await dockerComposeCmd(composeProject, ["stop", "agenthub-server", "traefik"]);

  // 2. Replace .env
  log("[restore] replacing compose/.env...");
  copyFileSync(join(bundle.stagingDir, "env"), join(REPO_DIR, "compose", ".env"));

  // 3. Replace SQLite (atomic)
  log("[restore] replacing /data/agenthub.db...");
  copyFileSync(join(bundle.stagingDir, "agenthub.db"), DB_PATH);

  // 4. pg_restore (Infisical postgres must be up)
  log("[restore] restoring Infisical Postgres...");
  await pgRestore(bundle.stagingDir, composeProject, log);

  // 5. Bring stack back up
  log("[restore] starting agenthub services...");
  await dockerComposeCmd(composeProject, ["up", "-d"]);

  log("[restore] complete; verify /api/health");
}

async function dockerComposeCmd(
  project: string,
  args: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "--project-name", project,
        "-f", join(REPO_DIR, "compose", "docker-compose.yml"),
        ...args,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker compose ${args[0]} failed: ${stderr}`));
    });
  });
}

async function pgRestore(
  stagingDir: string,
  composeProject: string,
  log: (l: string) => void,
): Promise<void> {
  const dumpPath = join(stagingDir, "infisical.sql");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "--project-name", composeProject,
        "-f", join(REPO_DIR, "compose", "docker-compose.yml"),
        "exec", "-T", "infisical-postgres",
        "pg_restore",
        "-U", "infisical",
        "-d", "infisical",
        "--clean", "--if-exists", "--no-owner",
      ],
      { stdio: [createReadStream(dumpPath) as never, "pipe", "pipe"] },
    );
    child.stdout.on("data", (b) => log(`[pg_restore] ${b.toString().trim()}`));
    let stderr = "";
    child.stderr.on("data", (b) => {
      const s = b.toString();
      stderr += s;
      log(`[pg_restore] ${s.trim()}`);
    });
    child.on("close", (code) => {
      // pg_restore can return non-zero on benign warnings; check stderr
      if (code === 0 || stderr.includes("WARNING")) resolve();
      else reject(new Error(`pg_restore failed (exit ${code}): ${stderr.slice(-500)}`));
    });
  });
}
