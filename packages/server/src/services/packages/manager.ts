import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import type { UserPackage, UserPackageStatus } from "../../db/schema.js";
import type {
  PackageOpParams,
  PackageOpResult,
  SessionManager,
} from "../session-manager.js";
import { getPackage, listCatalog, type PackageManifest } from "./catalog.js";

export type CatalogState =
  | "preinstalled"
  | "not-installed"
  | "installing"
  | "ready"
  | "removing"
  | "error";

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  homepage?: string;
  isBuiltin: boolean;
  state: CatalogState;
  version?: string | null;
  error?: string | null;
  updatedAt?: string | null;
}

export class PackageManager {
  constructor(private readonly sessionManager: SessionManager) {}

  /** Merge the catalog with the user's install rows for a single response. */
  listForUser(userId: string): CatalogEntry[] {
    const rows = this.getRowsForUser(userId);
    const byPackage = new Map<string, UserPackage>();
    for (const r of rows) byPackage.set(r.packageId, r);

    return listCatalog().map((manifest) => {
      const base: CatalogEntry = {
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        isBuiltin: Boolean(manifest.isBuiltin),
        state: manifest.isBuiltin ? "preinstalled" : "not-installed",
      };
      if (manifest.homepage !== undefined) base.homepage = manifest.homepage;
      if (manifest.isBuiltin) return base;

      const row = byPackage.get(manifest.id);
      if (!row) return base;

      return {
        ...base,
        state: mapRowStatusToState(row.status),
        version: row.version ?? null,
        error: row.error ?? null,
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  /** Return a single package's status for the polling endpoint. */
  getStatus(userId: string, packageId: string): CatalogEntry | null {
    const manifest = getPackage(packageId);
    if (!manifest) return null;
    if (manifest.isBuiltin) {
      return this.listForUser(userId).find((e) => e.id === packageId) ?? null;
    }
    const row = db
      .select()
      .from(schema.userPackages)
      .where(
        and(
          eq(schema.userPackages.userId, userId),
          eq(schema.userPackages.packageId, packageId),
        ),
      )
      .get();

    const base: CatalogEntry = {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      isBuiltin: false,
      state: "not-installed",
    };
    if (manifest.homepage !== undefined) base.homepage = manifest.homepage;
    if (!row) return base;
    return {
      ...base,
      state: mapRowStatusToState(row.status),
      version: row.version ?? null,
      error: row.error ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Kick off an install. The install itself happens async — the HTTP caller
   * gets back immediately; the DB row transitions `installing` → `ready`
   * (or `error`) once the agent replies.
   */
  async startInstall(
    userId: string,
    packageId: string,
  ): Promise<{ status: "started"; state: CatalogState } | { status: "conflict"; reason: string }> {
    const manifest = getPackage(packageId);
    if (!manifest) return { status: "conflict", reason: "unknown package" };
    if (manifest.isBuiltin) {
      return { status: "conflict", reason: "built-in packages are always pre-installed" };
    }

    const existing = this.getRow(userId, packageId);
    if (existing) {
      if (existing.status === "installing") {
        return { status: "conflict", reason: "install already in progress" };
      }
      if (existing.status === "ready") {
        return { status: "conflict", reason: "already installed" };
      }
      if (existing.status === "removing") {
        return { status: "conflict", reason: "remove in progress" };
      }
    }

    const now = new Date();
    if (existing) {
      db.update(schema.userPackages)
        .set({ status: "installing", error: null, updatedAt: now })
        .where(eq(schema.userPackages.id, existing.id))
        .run();
    } else {
      db.insert(schema.userPackages)
        .values({
          id: randomUUID(),
          userId,
          packageId,
          status: "installing",
          installedAt: now,
          updatedAt: now,
        })
        .run();
    }

    void this.runInstall(userId, packageId, manifest);
    return { status: "started", state: "installing" };
  }

  async startRemove(
    userId: string,
    packageId: string,
  ): Promise<{ status: "started"; state: CatalogState } | { status: "conflict"; reason: string } | { status: "not-found" }> {
    const manifest = getPackage(packageId);
    if (!manifest) return { status: "conflict", reason: "unknown package" };
    if (manifest.isBuiltin) {
      return { status: "conflict", reason: "built-in packages cannot be removed" };
    }

    const existing = this.getRow(userId, packageId);
    if (!existing) return { status: "not-found" };
    if (existing.status === "installing") {
      return { status: "conflict", reason: "install in progress — wait for it to finish" };
    }
    if (existing.status === "removing") {
      return { status: "conflict", reason: "remove already in progress" };
    }

    const now = new Date();
    db.update(schema.userPackages)
      .set({ status: "removing", error: null, updatedAt: now })
      .where(eq(schema.userPackages.id, existing.id))
      .run();

    void this.runRemove(userId, packageId, manifest);
    return { status: "started", state: "removing" };
  }

  private async runInstall(
    userId: string,
    packageId: string,
    manifest: PackageManifest,
  ): Promise<void> {
    const params: PackageOpParams = {
      packageId: manifest.id,
      binName: manifest.binName,
      versionCmd: manifest.versionCmd,
      spec: manifest.install,
    };
    let result: PackageOpResult;
    try {
      result = await this.sessionManager.packageViaAgent(userId, "install", params);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      this.finishRow(userId, packageId, { status: "error", error: msg });
      return;
    }

    if (result.ok) {
      this.finishRow(userId, packageId, {
        status: "ready",
        error: null,
        version: result.version ?? null,
      });
    } else {
      this.finishRow(userId, packageId, {
        status: "error",
        error: result.error ?? "install failed",
      });
    }
  }

  private async runRemove(
    userId: string,
    packageId: string,
    manifest: PackageManifest,
  ): Promise<void> {
    const params: PackageOpParams = {
      packageId: manifest.id,
      binName: manifest.binName,
      versionCmd: manifest.versionCmd,
      spec: manifest.install,
    };
    let result: PackageOpResult;
    try {
      result = await this.sessionManager.packageViaAgent(userId, "remove", params);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      this.finishRow(userId, packageId, { status: "error", error: msg });
      return;
    }

    if (result.ok) {
      this.deleteRow(userId, packageId);
    } else {
      this.finishRow(userId, packageId, {
        status: "error",
        error: result.error ?? "remove failed",
      });
    }
  }

  private getRow(userId: string, packageId: string): UserPackage | undefined {
    return db
      .select()
      .from(schema.userPackages)
      .where(
        and(
          eq(schema.userPackages.userId, userId),
          eq(schema.userPackages.packageId, packageId),
        ),
      )
      .get();
  }

  private getRowsForUser(userId: string): UserPackage[] {
    return db
      .select()
      .from(schema.userPackages)
      .where(eq(schema.userPackages.userId, userId))
      .all();
  }

  private finishRow(
    userId: string,
    packageId: string,
    patch: { status: UserPackageStatus; error?: string | null; version?: string | null },
  ): void {
    const update: Partial<typeof schema.userPackages.$inferInsert> = {
      status: patch.status,
      updatedAt: new Date(),
    };
    if (patch.error !== undefined) update.error = patch.error;
    if (patch.version !== undefined) update.version = patch.version;

    db.update(schema.userPackages)
      .set(update)
      .where(
        and(
          eq(schema.userPackages.userId, userId),
          eq(schema.userPackages.packageId, packageId),
        ),
      )
      .run();
  }

  private deleteRow(userId: string, packageId: string): void {
    db.delete(schema.userPackages)
      .where(
        and(
          eq(schema.userPackages.userId, userId),
          eq(schema.userPackages.packageId, packageId),
        ),
      )
      .run();
  }
}

function mapRowStatusToState(status: UserPackageStatus): CatalogState {
  switch (status) {
    case "installing": return "installing";
    case "ready":      return "ready";
    case "removing":   return "removing";
    case "error":      return "error";
  }
}
