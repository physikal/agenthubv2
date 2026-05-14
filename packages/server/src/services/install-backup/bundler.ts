import { writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, statSync, mkdtempSync } from "fs";
import { spawn } from "child_process";
import { join } from "path";
import { randomUUID } from "crypto";
import { BUNDLE_SCHEMA_VERSION, type BundleManifest } from "./types.js";
import { serializeManifest } from "./manifest.js";

const BACKUPS_DIR = "/data/install-backups";
const REPO_DIR = "/repo";
const DB_PATH = "/data/agenthub.db";

export interface BundleOptions {
  trigger: BundleManifest["trigger"];
  note?: string;
  sourceDomain: string;
  gitSha: string;
  composeProject?: string;
}

export interface BundleResult {
  bundlePath: string;
  bytes: number;
  filename: string;
  manifest: BundleManifest;
}

export function writeStagingManifest(
  stagingDir: string,
  manifest: BundleManifest,
): void {
  writeFileSync(join(stagingDir, "manifest.json"), serializeManifest(manifest));
}

export async function packBundle(stagingDir: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "tar",
      ["-C", stagingDir, "-czf", outPath, "env", "agenthub.db", "infisical.sql", "manifest.json"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar failed (exit ${String(code)}): ${stderr}`));
    });
  });
}

async function dumpSqlite(outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("sqlite3", [DB_PATH, `.backup '${outPath}'`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sqlite3 .backup failed (exit ${String(code)}): ${stderr}`));
    });
  });
}

async function dumpInfisical(outPath: string, composeProject: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "--project-name", composeProject,
        "-f", join(REPO_DIR, "compose", "docker-compose.yml"),
        "exec", "-T", "infisical-postgres",
        "pg_dump", "-U", "infisical", "-F", "c", "-d", "infisical",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => { chunks.push(b); });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("close", (code) => {
      if (code === 0) {
        writeFileSync(outPath, Buffer.concat(chunks));
        resolve();
      } else {
        reject(new Error(`pg_dump failed (exit ${String(code)}): ${stderr}`));
      }
    });
  });
}

export async function createBundle(opts: BundleOptions): Promise<BundleResult> {
  mkdirSync(BACKUPS_DIR, { recursive: true });

  const stagingDir = mkdtempSync(join(BACKUPS_DIR, `staging-${randomUUID()}-`));
  const composeProject = opts.composeProject ?? "agenthub";

  try {
    await dumpSqlite(join(stagingDir, "agenthub.db"));
    await dumpInfisical(join(stagingDir, "infisical.sql"), composeProject);

    const envSrc = join(REPO_DIR, "compose", ".env");
    if (!existsSync(envSrc)) {
      throw new Error(`compose/.env not found at ${envSrc}; cannot bundle`);
    }
    copyFileSync(envSrc, join(stagingDir, "env"));

    const manifest: BundleManifest = {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      sourceDomain: opts.sourceDomain,
      gitSha: opts.gitSha,
      composeVersion: "v2",
      trigger: opts.trigger,
      ...(opts.note ? { note: opts.note } : {}),
    };
    writeStagingManifest(stagingDir, manifest);

    const tsForFilename = manifest.createdAt.replace(/:/g, "-").replace(/\..+$/, "Z");
    const filename = `install-${opts.sourceDomain}-${tsForFilename}.tar.gz`;
    const bundlePath = join(BACKUPS_DIR, filename);
    await packBundle(stagingDir, bundlePath);

    const bytes = statSync(bundlePath).size;
    return { bundlePath, bytes, filename, manifest };
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
