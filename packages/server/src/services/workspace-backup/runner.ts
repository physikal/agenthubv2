import { bundleWorkspace } from "./bundler.js";
import { restoreWorkspace } from "./restorer.js";
import { parseBundleFilename } from "./manifest.js";
import type { B2Config } from "../install-backup/types.js";
import { b2Push, b2Pull, b2List, b2RemotePath } from "../install-backup/b2-client.js";
import { db, schema } from "../../db/index.js";
import { and, eq, inArray } from "drizzle-orm";
import { mkdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceTrigger, WorkspaceBackupResult } from "./types.js";

const HOST_BACKUP_DIR = process.env["AGENTHUB_WORKSPACE_BACKUP_DIR"] ?? "/data/workspace-backups";

function userDir(userId: string): string {
  // Explicit charset check — independent of volumeNameForUser so a future
  // change to the volume prefix doesn't silently invert this path.
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) {
    throw new Error(`refusing to build backup path for unsafe userId: ${userId}`);
  }
  return join(HOST_BACKUP_DIR, userId);
}

function b2WorkspacesPath(cfg: B2Config, userId: string, filename: string): string {
  // Slot under <prefix>workspaces/<userId>/<filename>. Reuse b2RemotePath's
  // path builder by inflating a transient config with the same bucket /
  // appended prefix.
  const cfgForUser: B2Config = {
    ...cfg,
    pathPrefix: `${cfg.pathPrefix.replace(/\/+$/, "")}/workspaces/${userId}`,
  };
  return b2RemotePath(cfgForUser, filename);
}

export interface WorkspaceBackupRunInput {
  userId: string;
  userEmail: string | null;
  workspaceImageSha: string | null;
  trigger: WorkspaceTrigger;
  note?: string;
  b2: B2Config | null;
  onLog?: (line: string) => void;
}

export interface WorkspaceBackupRunResult extends WorkspaceBackupResult {
  b2Path: string | null;
}

export async function runWorkspaceBackup(
  input: WorkspaceBackupRunInput,
): Promise<WorkspaceBackupRunResult> {
  const dest = userDir(input.userId);
  mkdirSync(dest, { recursive: true });
  input.onLog?.(`[ws-backup] bundling /home/coder for ${input.userId}`);
  const bundleArgs: Parameters<typeof bundleWorkspace>[0] = {
    userId: input.userId,
    userEmail: input.userEmail,
    workspaceImageSha: input.workspaceImageSha,
    trigger: input.trigger,
    destDir: dest,
  };
  if (input.note !== undefined) bundleArgs.note = input.note;
  const bundle = await bundleWorkspace(bundleArgs);
  input.onLog?.(
    `[ws-backup] bundle ${bundle.bundlePath} (${formatBytes(bundle.bytes)})`,
  );

  let b2Path: string | null = null;
  if (input.b2) {
    input.onLog?.(`[ws-backup] pushing to B2`);
    const filename = bundle.bundlePath.split("/").pop() as string;
    const remote = b2WorkspacesPath(input.b2, input.userId, filename);
    const cfgForUser: B2Config = {
      ...input.b2,
      pathPrefix: `${input.b2.pathPrefix.replace(/\/+$/, "")}/workspaces/${input.userId}`,
    };
    await b2Push(cfgForUser, bundle.bundlePath, filename, (l) =>
      input.onLog?.(`[rclone] ${l}`),
    );
    b2Path = remote;
    input.onLog?.(`[ws-backup] pushed → ${remote}`);
  }

  return { ...bundle, b2Path };
}

export interface WorkspaceRestoreRunInput {
  userId: string;
  /** When set, restore directly from this local path (skip B2 pull). */
  localBundlePath?: string;
  /** When set, pull this snapshot name from B2 before restoring. "latest"
   * resolves to the most-recent bundle in the user's B2 directory. */
  b2Snapshot?: "latest" | string;
  b2: B2Config | null;
  force?: boolean;
  onLog?: (line: string) => void;
}

export interface WorkspaceRestoreRunResult {
  source: string;
  extractedBytes: number;
}

export async function runWorkspaceRestore(
  input: WorkspaceRestoreRunInput,
): Promise<WorkspaceRestoreRunResult> {
  let bundlePath = input.localBundlePath;

  if (!bundlePath && input.b2Snapshot && input.b2) {
    const cfgForUser: B2Config = {
      ...input.b2,
      pathPrefix: `${input.b2.pathPrefix.replace(/\/+$/, "")}/workspaces/${input.userId}`,
    };
    let filename = input.b2Snapshot;
    if (filename === "latest") {
      input.onLog?.(`[ws-restore] listing B2 for ${input.userId}`);
      const names = await b2List(cfgForUser, "");
      const matching = names.filter((n) => parseBundleFilename(n));
      if (matching.length === 0) {
        throw new Error(`no workspace backups found for user ${input.userId} in B2`);
      }
      // Filename timestamps are ISO-with-dashes, lexicographic = chronological.
      matching.sort();
      filename = matching[matching.length - 1] as string;
      input.onLog?.(`[ws-restore] latest = ${filename}`);
    }
    const dest = userDir(input.userId);
    mkdirSync(dest, { recursive: true });
    bundlePath = join(dest, filename);
    if (!existsSync(bundlePath)) {
      input.onLog?.(`[ws-restore] pulling ${filename} from B2`);
      await b2Pull(cfgForUser, filename, bundlePath, (l) =>
        input.onLog?.(`[rclone] ${l}`),
      );
    } else {
      input.onLog?.(`[ws-restore] reusing cached bundle ${bundlePath}`);
    }
  }

  if (!bundlePath) {
    throw new Error(
      "runWorkspaceRestore requires either localBundlePath or b2Snapshot+b2",
    );
  }
  if (!existsSync(bundlePath)) {
    throw new Error(`bundle not found: ${bundlePath}`);
  }

  // Refuse to restore while a session is actively mounting the volume —
  // docker volume rm during a live mount produces an orphaned volume the
  // running container keeps writing to, with the restored data silently
  // diverging on the freshly-created replacement. Force-flag operators
  // must explicitly end sessions first.
  const ACTIVE_STATUSES = [
    "creating", "starting", "waiting_login", "active", "waiting_input", "idle",
  ] as const;
  const active = db
    .select({ id: schema.sessions.id, status: schema.sessions.status })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.userId, input.userId),
        inArray(schema.sessions.status, ACTIVE_STATUSES),
      ),
    )
    .all();
  if (active.length > 0) {
    throw new Error(
      `user ${input.userId} has ${active.length} active session(s) — end them before restore (force-flag is intentionally NOT honoured here)`,
    );
  }

  const bytes = statSync(bundlePath).size;
  input.onLog?.(
    `[ws-restore] restoring ${bundlePath} (${formatBytes(bytes)}) into volume for ${input.userId}`,
  );
  const result = await restoreWorkspace({
    userId: input.userId,
    bundlePath,
    force: input.force ?? false,
  });
  input.onLog?.(
    `[ws-restore] done — ${formatBytes(result.extractedBytes)} on-volume`,
  );
  return { source: bundlePath, extractedBytes: result.extractedBytes };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
