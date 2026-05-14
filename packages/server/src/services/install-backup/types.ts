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

export interface B2Config {
  keyId: string;
  appKey: string; // resolved from Infisical at runtime; never persisted to SQLite
  bucket: string;
  pathPrefix: string;
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
