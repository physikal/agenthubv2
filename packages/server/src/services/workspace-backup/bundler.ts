import { execFile } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { promisify } from "node:util";
import {
  bundleFilename,
  serializeWorkspaceManifest,
} from "./manifest.js";
import type { WorkspaceBackupResult, WorkspaceBundleManifest, WorkspaceTrigger } from "./types.js";
import { WORKSPACE_BUNDLE_SCHEMA_VERSION } from "./types.js";
import { volumeNameForUser } from "./volume.js";

const execFileAsync = promisify(execFile);

const SIDECAR_IMAGE = process.env["AGENTHUB_SERVER_IMAGE"] ?? "agenthubv2-server:local";

/**
 * Resolve the docker-named data volume that this server container has
 * mounted at /data. The sidecar mounts it by name so its `/dst` is the
 * same filesystem the server sees at `/data` — no host-path translation
 * needed and no docker-in-docker shenanigans.
 *
 * Cached for the process lifetime.
 */
let dataVolumeCache: string | null = null;
export async function getDataVolumeName(): Promise<string> {
  if (dataVolumeCache) return dataVolumeCache;
  const { stdout } = await execFileAsync(
    "docker",
    [
      "inspect",
      "--format",
      '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}',
      hostname(),
    ],
    { timeout: 5_000 },
  );
  const name = stdout.trim();
  if (!name) {
    throw new Error(
      `could not resolve data volume name (looking for /data mount on container ${hostname()})`,
    );
  }
  dataVolumeCache = name;
  return name;
}

interface BundleInput {
  userId: string;
  userEmail: string | null;
  workspaceImageSha: string | null;
  trigger: WorkspaceTrigger;
  note?: string;
  /** Host-side directory for the bundle. Created if missing. */
  destDir: string;
}

/**
 * Snapshot `agenthub-home-{userId}` to a tar.zst bundle on the host
 * filesystem. Uses a one-shot sidecar container that mounts the volume
 * read-only and writes to the host bind-mount. Embeds a manifest as the
 * first entry in the tar (rolled into the archive itself, not separately
 * uploaded) so restorers can introspect the bundle before extracting.
 */
export async function bundleWorkspace(input: BundleInput): Promise<WorkspaceBackupResult> {
  const volume = volumeNameForUser(input.userId);
  const dataVol = await getDataVolumeName();
  // input.destDir is the server-container-visible path (under /data/...).
  // The sidecar can't see that path directly — it sees the same content at
  // the same path via the named data volume mounted at /dst.
  if (!input.destDir.startsWith("/data/")) {
    throw new Error(`bundler destDir must be under /data/, got ${input.destDir}`);
  }
  mkdirSync(input.destDir, { recursive: true });
  const sidecarDest = input.destDir.replace(/^\/data\//, "/dst/").replace(/\/+$/, "");

  const createdAt = new Date().toISOString();
  const filename = bundleFilename(input.userId, createdAt);
  const bundlePath = `${input.destDir.replace(/\/+$/, "")}/${filename}`;

  const manifest: WorkspaceBundleManifest = {
    schemaVersion: WORKSPACE_BUNDLE_SCHEMA_VERSION,
    createdAt,
    userId: input.userId,
    userEmail: input.userEmail,
    workspaceImageSha: input.workspaceImageSha,
    trigger: input.trigger,
  };
  if (input.note !== undefined) manifest.note = input.note;
  const manifestJson = serializeWorkspaceManifest(manifest);

  // Sidecar: write manifest first, then tar+zstd the volume contents. The
  // tar archive contains:
  //   ./agenthub-workspace-manifest.json
  //   ./<volume contents>
  // Reading the manifest is a streaming-tar operation; the restorer only
  // needs the first ~1KB of the file.
  try {
    await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${volume}:/src:ro`,
        "-v",
        `${dataVol}:/dst`,
        "--network",
        "none",
        "-e",
        `MANIFEST_JSON=${manifestJson}`,
        "-e",
        `BUNDLE_FILENAME=${filename}`,
        "-e",
        `SIDECAR_DEST=${sidecarDest}`,
        SIDECAR_IMAGE,
        "sh",
        "-c",
        [
          "set -eu",
          'mkdir -p "$SIDECAR_DEST" /work',
          "printf '%s' \"$MANIFEST_JSON\" > /work/agenthub-workspace-manifest.json",
          // tar streams stdout → zstd → $SIDECAR_DEST/$BUNDLE_FILENAME
          // --warning=no-file-changed lets the user's session write to the
          // volume mid-snapshot without aborting tar.
          "(cd /work && tar c --warning=no-file-changed agenthub-workspace-manifest.json) > /tmp/header.tar",
          // Now append the volume contents to the manifest header tar.
          "tar -rf /tmp/header.tar -C /src --warning=no-file-changed .",
          'zstd -T0 -19 < /tmp/header.tar > "$SIDECAR_DEST/$BUNDLE_FILENAME"',
        ].join(" && "),
      ],
      { timeout: 1800_000, maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const tail = stderr.slice(-500);
    throw new Error(
      `bundleWorkspace failed for user ${input.userId}: ${tail || String(err)}`,
    );
  }

  const bytes = statSync(bundlePath).size;
  return { bundlePath, bytes, manifest };
}
