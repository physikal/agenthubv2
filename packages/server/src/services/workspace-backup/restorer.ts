import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";
import {
  dockerVolumeCreate,
  dockerVolumeExists,
  dockerVolumeIsEmpty,
  dockerVolumeRemove,
  volumeNameForUser,
} from "./volume.js";
import { getDataVolumeName } from "./bundler.js";

const execFileAsync = promisify(execFile);
const SIDECAR_IMAGE = process.env["AGENTHUB_SERVER_IMAGE"] ?? "agenthubv2-server:local";

export interface RestoreOptions {
  userId: string;
  /** Local path to the .tar.zst bundle. */
  bundlePath: string;
  /** Allow extracting onto a non-empty volume — operator-confirmed
   * destructive operation. Default false. */
  force?: boolean;
}

/**
 * Extract a workspace tar.zst bundle into `agenthub-home-{userId}`.
 *
 * Safety:
 *   - Refuses to write to a non-empty volume unless `force=true`.
 *   - Creates the volume if missing.
 *   - On `force`: removes + recreates the volume so we never half-merge.
 *
 * Callers SHOULD stop any active sessions for the user before calling
 * (Docker will reject volume rm if a container has it mounted). The
 * runner is responsible for orchestrating that.
 */
export async function restoreWorkspace(opts: RestoreOptions): Promise<{ extractedBytes: number }> {
  const volume = volumeNameForUser(opts.userId);

  if (await dockerVolumeExists(volume)) {
    const empty = await dockerVolumeIsEmpty(volume);
    if (!empty && !opts.force) {
      throw new Error(
        `workspace volume ${volume} is not empty — pass force=true to overwrite`,
      );
    }
    if (opts.force && !empty) {
      await dockerVolumeRemove(volume);
      await dockerVolumeCreate(volume);
    }
  } else {
    await dockerVolumeCreate(volume);
  }

  // Sidecar streams: zstd -d /data-mount/.../file.tar.zst → tar -x into
  // /dst (the user workspace volume). The bundle file lives in the
  // server's own /data volume (mounted at /data-mount via the named
  // volume). Filename passes through an env var (not sh -c
  // interpolation) so an operator-supplied bundle path can't break
  // out of the quoted string. opts.bundlePath is the server-visible
  // path (under /data/...) — translate to /data-mount for the sidecar.
  if (!opts.bundlePath.startsWith("/data/")) {
    throw new Error(`restorer bundlePath must be under /data/, got ${opts.bundlePath}`);
  }
  const dataVol = await getDataVolumeName();
  const filename = basename(opts.bundlePath);
  const sidecarDir = dirname(opts.bundlePath).replace(/^\/data\//, "/data-mount/");
  try {
    await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${volume}:/dst`,
        "-v",
        `${dataVol}:/data-mount:ro`,
        "--network",
        "none",
        "-e",
        `BUNDLE_FILENAME=${filename}`,
        "-e",
        `SIDECAR_DIR=${sidecarDir}`,
        SIDECAR_IMAGE,
        "sh",
        "-c",
        [
          "set -eu",
          'zstd -dc "$SIDECAR_DIR/$BUNDLE_FILENAME" | tar x -C /dst --exclude=./agenthub-workspace-manifest.json',
        ].join(" && "),
      ],
      { timeout: 1800_000, maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const tail = stderr.slice(-500);
    throw new Error(
      `restoreWorkspace failed for user ${opts.userId}: ${tail || String(err)}`,
    );
  }

  // Best-effort size measurement — du -sb is supported in the agenthub-server
  // image (coreutils/busybox). If it fails, return 0 rather than blocking
  // restore-success on the metric.
  let extractedBytes = 0;
  try {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${volume}:/dst:ro`,
        "--network",
        "none",
        SIDECAR_IMAGE,
        "sh",
        "-c",
        "du -sb /dst | cut -f1",
      ],
      { timeout: 60_000 },
    );
    extractedBytes = parseInt(stdout.trim(), 10) || 0;
  } catch {
    extractedBytes = 0;
  }

  return { extractedBytes };
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}
