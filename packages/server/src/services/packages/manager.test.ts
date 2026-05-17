import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema, initDb } from "../../db/index.js";
import type { SessionManager } from "../session-manager.js";
import { PackageManager } from "./manager.js";

// recordEssentialResult is the upsert path called when the agent reports an
// `essentials.result` for an auto-installed CLI. Tests focus on the state
// machine, not on session plumbing — the SessionManager dependency is
// satisfied with a minimal stub.

const stubSessionManager = {} as unknown as SessionManager;

beforeAll(() => {
  initDb();
});

const USER = "user-1";

function getRow(userId: string, packageId: string) {
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

describe("PackageManager.recordEssentialResult", () => {
  beforeEach(() => {
    db.delete(schema.userPackages).run();
    db.delete(schema.users).run();
    db.insert(schema.users).values({
      id: USER,
      username: "tester",
      passwordHash: "x",
      displayName: "tester",
    }).run();
  });

  it("inserts a ready row when no prior row exists and ok=true", () => {
    const mgr = new PackageManager(stubSessionManager);
    mgr.recordEssentialResult(USER, "claude-code", true, "2.1.143", null);
    const row = getRow(USER, "claude-code");
    expect(row?.status).toBe("ready");
    expect(row?.version).toBe("2.1.143");
    expect(row?.error).toBeNull();
  });

  it("updates existing row to ready+version on ok=true", () => {
    const mgr = new PackageManager(stubSessionManager);
    db.insert(schema.userPackages).values({
      id: "existing",
      userId: USER,
      packageId: "claude-code",
      status: "error",
      error: "previous failure",
      installedAt: new Date(),
      updatedAt: new Date(),
    }).run();

    mgr.recordEssentialResult(USER, "claude-code", true, "2.1.144", null);
    const row = getRow(USER, "claude-code");
    expect(row?.status).toBe("ready");
    expect(row?.version).toBe("2.1.144");
    expect(row?.error).toBeNull();
  });

  it("inserts an error row when ok=false and no prior row exists", () => {
    const mgr = new PackageManager(stubSessionManager);
    mgr.recordEssentialResult(USER, "claude-code", false, null, "npm 503");
    const row = getRow(USER, "claude-code");
    expect(row?.status).toBe("error");
    expect(row?.error).toBe("npm 503");
  });

  it("does NOT overwrite a working ready row when ok=false (transient failure)", () => {
    const mgr = new PackageManager(stubSessionManager);
    db.insert(schema.userPackages).values({
      id: "existing",
      userId: USER,
      packageId: "claude-code",
      status: "ready",
      version: "2.1.143",
      installedAt: new Date(),
      updatedAt: new Date(),
    }).run();

    mgr.recordEssentialResult(USER, "claude-code", false, null, "npm timeout");
    const row = getRow(USER, "claude-code");
    expect(row?.status).toBe("ready");
    expect(row?.version).toBe("2.1.143");
    expect(row?.error).toBeNull();
  });

  it("overwrites a non-ready row when ok=false", () => {
    const mgr = new PackageManager(stubSessionManager);
    db.insert(schema.userPackages).values({
      id: "existing",
      userId: USER,
      packageId: "claude-code",
      status: "installing",
      installedAt: new Date(),
      updatedAt: new Date(),
    }).run();

    mgr.recordEssentialResult(USER, "claude-code", false, null, "real failure");
    const row = getRow(USER, "claude-code");
    expect(row?.status).toBe("error");
    expect(row?.error).toBe("real failure");
  });

  it("ignores unknown package ids without throwing", () => {
    const mgr = new PackageManager(stubSessionManager);
    expect(() =>
      mgr.recordEssentialResult(USER, "not-in-catalog", true, "1.0.0", null),
    ).not.toThrow();
    expect(getRow(USER, "not-in-catalog")).toBeUndefined();
  });
});
