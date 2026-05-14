import { spawn } from "child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { B2Config } from "./types.js";

export function buildRcloneConfig(c: B2Config): string {
  // The remote name stays "b2" regardless of backend type so callers
  // (b2Push/b2Pull/b2List/b2Delete) don't need to know which backend
  // they're talking to. Section name is opaque to the user.
  if (c.backend === "s3") {
    const lines = [
      "[b2]",
      "type = s3",
      // "Other" tells rclone "this isn't AWS itself — accept user-provided
      // endpoint without trying AWS-specific behavior." Works for R2,
      // MinIO, Wasabi, Storj, Backblaze S3-compat endpoint.
      "provider = Other",
      `access_key_id = ${c.keyId}`,
      `secret_access_key = ${c.appKey}`,
      `region = ${c.region ?? "auto"}`,
    ];
    if (c.endpoint) lines.push(`endpoint = ${c.endpoint}`);
    lines.push("hard_delete = true", "");
    return lines.join("\n");
  }
  // Default: native Backblaze B2.
  return [
    "[b2]",
    "type = b2",
    `account = ${c.keyId}`,
    `key = ${c.appKey}`,
    "hard_delete = true",
    "",
  ].join("\n");
}

export function b2RemotePath(c: B2Config, filename: string): string {
  const prefix = c.pathPrefix.replace(/\/+$/, "");
  const joined = prefix ? `${prefix}/${filename}` : filename;
  return `b2:${c.bucket}/${joined}`;
}

async function runRclone(
  cfg: B2Config,
  args: string[],
  onLine?: (line: string) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "rclone-"));
  const configPath = join(tmp, "rclone.conf");
  writeFileSync(configPath, buildRcloneConfig(cfg), { mode: 0o600 });
  try {
    return await new Promise((resolve) => {
      const child = spawn("rclone", ["--config", configPath, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b: Buffer) => {
        const s = b.toString();
        stdout += s;
        if (onLine) for (const line of s.split("\n")) if (line) onLine(line);
      });
      child.stderr.on("data", (b: Buffer) => {
        const s = b.toString();
        stderr += s;
        if (onLine) for (const line of s.split("\n")) if (line) onLine(line);
      });
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  } finally {
    try {
      unlinkSync(configPath);
    } catch {
      // best-effort cleanup
    }
  }
}

export async function b2Push(
  cfg: B2Config,
  localPath: string,
  remoteFilename: string,
  onLine?: (line: string) => void,
): Promise<void> {
  const remote = b2RemotePath(cfg, remoteFilename);
  const result = await runRclone(cfg, ["copyto", localPath, remote, "--progress"], onLine);
  if (result.code !== 0) {
    throw new Error(`rclone push failed (exit ${result.code}): ${result.stderr.slice(-500)}`);
  }
}

export async function b2Pull(
  cfg: B2Config,
  remoteFilename: string,
  localPath: string,
  onLine?: (line: string) => void,
): Promise<void> {
  const remote = b2RemotePath(cfg, remoteFilename);
  const result = await runRclone(cfg, ["copyto", remote, localPath, "--progress"], onLine);
  if (result.code !== 0) {
    throw new Error(`rclone pull failed (exit ${result.code}): ${result.stderr.slice(-500)}`);
  }
}

export async function b2List(cfg: B2Config, prefix = ""): Promise<string[]> {
  const fullPrefix = b2RemotePath(cfg, prefix);
  const result = await runRclone(cfg, ["lsf", fullPrefix]);
  if (result.code !== 0) {
    throw new Error(`rclone list failed (exit ${result.code}): ${result.stderr.slice(-500)}`);
  }
  return result.stdout.split("\n").filter((l) => l.trim());
}

export async function b2Delete(cfg: B2Config, remoteFilename: string): Promise<void> {
  const remote = b2RemotePath(cfg, remoteFilename);
  const result = await runRclone(cfg, ["delete", remote]);
  if (result.code !== 0 && !result.stderr.includes("not found")) {
    throw new Error(`rclone delete failed (exit ${result.code}): ${result.stderr.slice(-500)}`);
  }
}
