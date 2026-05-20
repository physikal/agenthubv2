import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema, initDb } from "../../db/index.js";
import { startWorkspaceRun, finishWorkspaceRun, listWorkspaceRuns } from "./history.js";

const USER = "hist-user-1";

beforeAll(() => {
  initDb();
});

beforeEach(() => {
  db.delete(schema.backupRuns).where(eq(schema.backupRuns.userId, USER)).run();
  db.insert(schema.users).values({
    id: USER, username: "hist", displayName: "h", role: "user",
    passwordHash: "x", createdAt: new Date(),
  }).onConflictDoNothing().run();
});

describe("workspace history", () => {
  it("records a running row then marks it success with metadata", () => {
    const id = startWorkspaceRun(USER, "save", "manual");
    finishWorkspaceRun(id, "success", { bytes: 123, localPath: "/data/x.tar.zst", b2Path: "b2://x" });
    const rows = listWorkspaceRuns(USER, 10);
    expect(rows[0]?.status).toBe("success");
    expect(rows[0]?.bytes).toBe(123);
    expect(rows[0]?.b2Path).toBe("b2://x");
  });
});
