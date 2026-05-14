import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * `agenthub-home-{userId}` — the canonical naming for per-user workspace
 * volumes. SessionManager creates these on first session for a user; this
 * module reads / replaces them.
 */
export function volumeNameForUser(userId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) {
    throw new Error(`refusing to build volume name for unsafe userId: ${userId}`);
  }
  return `agenthub-home-${userId}`;
}

export async function dockerVolumeExists(name: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["volume", "inspect", name], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function dockerVolumeCreate(name: string): Promise<void> {
  await execFileAsync("docker", ["volume", "create", name], { timeout: 10_000 });
}

export async function dockerVolumeRemove(name: string): Promise<void> {
  await execFileAsync("docker", ["volume", "rm", name], { timeout: 10_000 });
}

/**
 * Treat a volume as "empty" when its top level has no entries other than
 * `lost+found` (which appears on ext4 mounts). Implementation: count files
 * via a tiny throwaway container.
 */
export async function dockerVolumeIsEmpty(name: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${name}:/src:ro`,
        "--network",
        "none",
        "alpine:3.21",
        "sh",
        "-c",
        "ls -1A /src | grep -v '^lost+found$' | head -1",
      ],
      { timeout: 15_000 },
    );
    return stdout.trim() === "";
  } catch {
    // Treat error (volume missing / docker hiccup) as "not empty" so the
    // caller doesn't assume it can safely write. Caller separately checks
    // existence with dockerVolumeExists.
    return false;
  }
}
