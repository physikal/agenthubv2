import { db, schema } from "../../db/index.js";
import { listCatalog } from "./catalog.js";
import { checkVersion } from "./version-check.js";

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Periodically polls each catalog entry's upstream version source and
 * upserts the result into `package_version_cache`. Started from
 * `packages/server/src/index.ts` after `initDb()`.
 *
 * One row per package. Both success and failure are recorded:
 *   - success → `latest_version` set, `error` cleared
 *   - failure → `latest_version` left alone (last-good preserved),
 *     `error` populated
 *
 * Entries whose install method has no upstream version source (curl-sh,
 * binary) record a stable `error` row — the UI surfaces this as "no
 * version source" rather than treating them as outdated.
 */
export class VersionPoller {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly intervalMs = DEFAULT_INTERVAL_MS) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    for (const manifest of listCatalog()) {
      const result = await checkVersion(manifest.install);
      const now = new Date();
      if ("latest" in result) {
        db.insert(schema.packageVersionCache)
          .values({
            packageId: manifest.id,
            latestVersion: result.latest,
            checkedAt: now,
            error: null,
          })
          .onConflictDoUpdate({
            target: schema.packageVersionCache.packageId,
            set: {
              latestVersion: result.latest,
              checkedAt: now,
              error: null,
            },
          })
          .run();
      } else {
        db.insert(schema.packageVersionCache)
          .values({
            packageId: manifest.id,
            latestVersion: null,
            checkedAt: now,
            error: result.error,
          })
          .onConflictDoUpdate({
            target: schema.packageVersionCache.packageId,
            set: {
              checkedAt: now,
              error: result.error,
            },
          })
          .run();
      }
    }
  }
}
