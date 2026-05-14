import { BUNDLE_SCHEMA_VERSION, type BundleManifest } from "./types.js";

const VALID_TRIGGERS = new Set(["manual", "auto-update", "cli"]);

export function serializeManifest(m: BundleManifest): string {
  return JSON.stringify(m, null, 2) + "\n";
}

export function parseManifest(json: string): BundleManifest {
  const raw = JSON.parse(json) as Record<string, unknown>;
  if (raw["schemaVersion"] !== BUNDLE_SCHEMA_VERSION) {
    throw new Error(
      `incompatible bundle schemaVersion=${String(raw["schemaVersion"])}, ` +
        `expected ${BUNDLE_SCHEMA_VERSION}`,
    );
  }
  for (const k of ["createdAt", "sourceDomain", "gitSha", "composeVersion", "trigger"]) {
    if (typeof raw[k] !== "string") {
      throw new Error(`manifest missing required field: ${k}`);
    }
  }
  const trigger = raw["trigger"] as string;
  if (!VALID_TRIGGERS.has(trigger)) {
    throw new Error(`manifest has invalid trigger: ${trigger}`);
  }
  const result: BundleManifest = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    createdAt: raw["createdAt"] as string,
    sourceDomain: raw["sourceDomain"] as string,
    gitSha: raw["gitSha"] as string,
    composeVersion: raw["composeVersion"] as string,
    trigger: trigger as BundleManifest["trigger"],
  };
  if (typeof raw["note"] === "string") result.note = raw["note"];
  return result;
}
