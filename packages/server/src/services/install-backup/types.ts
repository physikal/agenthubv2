export const BUNDLE_SCHEMA_VERSION = 1 as const;

export interface BundleManifest {
  schemaVersion: typeof BUNDLE_SCHEMA_VERSION;
  createdAt: string; // ISO 8601
  sourceDomain: string;
  gitSha: string;
  composeVersion: string;
  trigger: "manual" | "auto-update" | "cli";
  note?: string;
}

export interface BackupRunSummary {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "ok" | "failed";
  bytes: number | null;
  localPath: string | null;
  b2Path: string | null;
  trigger: "manual" | "auto-update" | "cli";
  error: string | null;
  note: string | null;
}

/**
 * Backup storage config. Despite the name, this can target any S3-compatible
 * backend (R2, MinIO, Wasabi, Storj, AWS S3) — not just Backblaze B2.
 *
 * `backend` defaults to "b2" for back-compat with installs configured before
 * pluggable backends landed. When `backend = "s3"`, the rclone config uses
 * the S3 driver with the same keyId/appKey fields and an optional `endpoint`
 * pointing at the non-AWS provider's S3 endpoint.
 */
export interface B2Config {
  /** Storage backend type. Defaults to "b2". */
  backend?: "b2" | "s3";
  /** B2 keyId, or for S3 backends, the access key id. */
  keyId: string;
  /** B2 application key, or for S3 backends, the secret access key.
   *  Resolved from Infisical at runtime; never persisted to SQLite. */
  appKey: string;
  /** Bucket name. */
  bucket: string;
  /** Path prefix inside the bucket (e.g. "installs/"). */
  pathPrefix: string;
  /** S3 endpoint for non-AWS providers. Examples:
   *    Cloudflare R2:  https://<account-id>.r2.cloudflarestorage.com
   *    MinIO:          https://s3.minio.example.com
   *    Wasabi:         https://s3.wasabisys.com
   *  Required when `backend = "s3"` and the backend isn't AWS itself. */
  endpoint?: string;
  /** S3 region. Defaults to "auto" (works for R2 and MinIO). */
  region?: string;
}

export type RestoreSource =
  | { kind: "local"; path: string }
  | { kind: "b2-url"; url: string }
  | { kind: "b2-snapshot"; snapshot: "latest" | string };

export interface Conflict {
  kind: "users-exist" | "secrets-exist" | "active-sessions" | "encryption-key-mismatch";
  detail: string;
}

export interface ConflictReport {
  ok: boolean;
  conflicts: Conflict[];
}
