import { readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { B2Config } from "../install-backup/types.js";
import { b2List, b2Delete } from "../install-backup/b2-client.js";
import { parseBundleFilename } from "./manifest.js";

/** Oldest-first list of bundle filenames to delete, keeping the newest
 * `keepLast`. Non-bundle filenames are ignored. `keepLast<=0` => delete all. */
export function pickBundlesToDelete(filenames: string[], keepLast: number): string[] {
  const bundles = filenames
    .filter((f) => parseBundleFilename(f) !== null)
    .sort();
  if (keepLast <= 0) return bundles;
  if (bundles.length <= keepLast) return [];
  return bundles.slice(0, bundles.length - keepLast);
}

/** Prune a user's local bundle dir (/data/workspace-backups/{userId}). */
export function pruneWorkspaceLocal(userDir: string, keepLast: number): string[] {
  if (!existsSync(userDir)) return [];
  const toDelete = pickBundlesToDelete(readdirSync(userDir), keepLast);
  for (const f of toDelete) {
    try {
      unlinkSync(join(userDir, f));
    } catch {
      // best-effort
    }
  }
  return toDelete;
}

/** Prune a user's B2 workspace dir. `cfg.pathPrefix` must already point at
 * that per-user dir (<prefix>/workspaces/{userId}). */
export async function pruneWorkspaceB2(cfg: B2Config, keepLast: number): Promise<string[]> {
  const toDelete = pickBundlesToDelete(await b2List(cfg, ""), keepLast);
  for (const f of toDelete) {
    try {
      await b2Delete(cfg, f);
    } catch {
      // best-effort
    }
  }
  return toDelete;
}
