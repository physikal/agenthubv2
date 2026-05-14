import { readdirSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import type { B2Config } from "./types.js";
import { b2List, b2Delete } from "./b2-client.js";

const BUNDLE_RE = /^install-.+-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.tar\.gz$/;

export function parseFilenameTimestamp(filename: string): string | null {
  const m = BUNDLE_RE.exec(filename);
  return m ? (m[1] ?? null) : null;
}

export function pickFilesToDelete(filenames: string[], keepLast: number): string[] {
  if (keepLast <= 0) return [];
  const bundles = filenames
    .filter((f) => parseFilenameTimestamp(f) !== null)
    .sort(); // ISO timestamp embedded; lexicographic == chronological
  if (bundles.length <= keepLast) return [];
  return bundles.slice(0, bundles.length - keepLast);
}

export function pruneLocal(dir: string, keepLast: number): string[] {
  if (!existsSync(dir)) return [];
  const all = readdirSync(dir);
  const toDelete = pickFilesToDelete(all, keepLast);
  for (const f of toDelete) {
    try {
      unlinkSync(join(dir, f));
    } catch {
      // best-effort: log but don't abort
    }
  }
  return toDelete;
}

export async function pruneB2(cfg: B2Config, keepLast: number): Promise<string[]> {
  const all = await b2List(cfg);
  const toDelete = pickFilesToDelete(all, keepLast);
  for (const f of toDelete) {
    try {
      await b2Delete(cfg, f);
    } catch {
      // best-effort: log but don't abort
    }
  }
  return toDelete;
}
