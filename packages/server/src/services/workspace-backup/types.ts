/**
 * Slice 4c: per-user workspace volume backup + restore.
 *
 * Each user has a `agenthub-home-{userId}` Docker volume mounted as
 * `/home/coder` inside their session container(s). This module snapshots
 * that volume as a tar.zst bundle and ships it to B2, mirroring the
 * install-backup layout but at user scope instead of operator scope.
 *
 * Path layout on B2:
 *   b2://<bucket>/<install-prefix>/workspaces/<userId>/workspace-<userId>-<ts>.tar.zst
 *
 * Reuses install-backup's `b2-client.ts` + `B2Config` row — operators
 * configure one B2 destination. The workspaces tree is rooted UNDER the
 * install-backup prefix (default `installs/`), so a typical layout is:
 *   b2://bucket/installs/install-<domain>-<ts>.tar.gz
 *   b2://bucket/installs/workspaces/<userId>/workspace-<userId>-<ts>.tar.zst
 * One configured B2 bucket+key holds everything.
 */

export const WORKSPACE_BUNDLE_SCHEMA_VERSION = 1 as const;

export type WorkspaceTrigger = "manual" | "cli" | "auto-update" | "auto-restore-install";

export interface WorkspaceBundleManifest {
  schemaVersion: typeof WORKSPACE_BUNDLE_SCHEMA_VERSION;
  createdAt: string;
  userId: string;
  /** User's email at bundle time — for operator-readable bundle listings.
   * Does NOT participate in restore (userId is the identity). */
  userEmail: string | null;
  /** SHA of the workspace image active when this bundle was produced. */
  workspaceImageSha: string | null;
  trigger: WorkspaceTrigger;
  note?: string;
}

export interface WorkspaceBackupResult {
  bundlePath: string;
  bytes: number;
  manifest: WorkspaceBundleManifest;
}
