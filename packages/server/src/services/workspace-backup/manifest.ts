import {
  WORKSPACE_BUNDLE_SCHEMA_VERSION,
  type WorkspaceBundleManifest,
  type WorkspaceTrigger,
} from "./types.js";

const VALID_TRIGGERS = new Set<WorkspaceTrigger>([
  "manual",
  "cli",
  "auto-restore-install",
]);

export function serializeWorkspaceManifest(m: WorkspaceBundleManifest): string {
  return JSON.stringify(m, null, 2) + "\n";
}

export function parseWorkspaceManifest(json: string): WorkspaceBundleManifest {
  const raw = JSON.parse(json) as Record<string, unknown>;
  if (raw["schemaVersion"] !== WORKSPACE_BUNDLE_SCHEMA_VERSION) {
    throw new Error(
      `incompatible workspace bundle schemaVersion=${String(raw["schemaVersion"])}, ` +
        `expected ${WORKSPACE_BUNDLE_SCHEMA_VERSION}`,
    );
  }
  for (const k of ["createdAt", "userId", "trigger"]) {
    if (typeof raw[k] !== "string") {
      throw new Error(`workspace manifest missing required field: ${k}`);
    }
  }
  const trigger = raw["trigger"] as string;
  if (!VALID_TRIGGERS.has(trigger as WorkspaceTrigger)) {
    throw new Error(`workspace manifest has invalid trigger: ${trigger}`);
  }
  const result: WorkspaceBundleManifest = {
    schemaVersion: WORKSPACE_BUNDLE_SCHEMA_VERSION,
    createdAt: raw["createdAt"] as string,
    userId: raw["userId"] as string,
    userEmail: typeof raw["userEmail"] === "string" ? (raw["userEmail"] as string) : null,
    workspaceImageSha:
      typeof raw["workspaceImageSha"] === "string"
        ? (raw["workspaceImageSha"] as string)
        : null,
    trigger: trigger as WorkspaceTrigger,
  };
  if (typeof raw["note"] === "string") result.note = raw["note"];
  return result;
}

/**
 * Bundle filename convention. Stable + sortable: workspace-{userId}-{ts}.tar.zst
 * The userId prefix lets `rclone lsf` output be filtered by user before download.
 */
export function bundleFilename(userId: string, isoTimestamp: string): string {
  // `:` is illegal in many filesystems / rclone path encodings; replace.
  const safeTs = isoTimestamp.replace(/[:.]/g, "-");
  return `workspace-${userId}-${safeTs}.tar.zst`;
}

/**
 * Parse the userId + timestamp out of a bundle filename. Returns null if it
 * doesn't match the expected convention — useful when listing a directory
 * that may contain unrelated files.
 */
export function parseBundleFilename(
  filename: string,
): { userId: string; timestamp: string } | null {
  // Non-greedy userId match so the timestamp anchor wins even when the
  // userId itself contains dashes (e.g. UUIDs).
  const m = /^workspace-(.+?)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.tar\.zst$/.exec(
    filename,
  );
  if (!m || !m[1] || !m[2]) return null;
  return { userId: m[1], timestamp: m[2] };
}
