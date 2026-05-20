import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkspaceBackupRunInput } from "../services/workspace-backup/runner.js";

const { runWorkspaceBackup, runWorkspaceRestore } = vi.hoisted(() => ({
  runWorkspaceBackup:
    vi.fn<
      (
        input: WorkspaceBackupRunInput,
      ) => Promise<{ bundlePath: string; bytes: number; b2Path: null; manifest: object }>
    >(),
  runWorkspaceRestore: vi.fn(async () => ({ source: "x", extractedBytes: 1 })),
}));
vi.mock("../services/workspace-backup/runner.js", () => ({ runWorkspaceBackup, runWorkspaceRestore }));
vi.mock("../services/install-backup/runner.js", () => ({ loadB2Config: vi.fn(async () => null) }));
vi.mock("../services/workspace-backup/history.js", () => ({ listWorkspaceRuns: vi.fn(() => []) }));

import { Hono } from "hono";
import type { AuthUser } from "../middleware/auth.js";
import { userWorkspaceBackupRoutes } from "./user-workspace-backup.js";

function appAs(userId: string) {
  const outer = new Hono<{ Variables: { user: AuthUser } }>();
  outer.use("*", async (c, next) => { c.set("user", { id: userId, username: "me", role: "user" }); await next(); });
  outer.route("/", userWorkspaceBackupRoutes());
  return outer;
}

beforeEach(() => {
  runWorkspaceBackup.mockReset();
  runWorkspaceBackup.mockResolvedValue({ bundlePath: "/data/workspace-backups/me/workspace-me-2026-05-20T00-00-00-000Z.tar.zst", bytes: 5, b2Path: null, manifest: {} });
  runWorkspaceRestore.mockClear();
});

describe("user-workspace-backup", () => {
  it("POST /run backs up the authenticated user only", async () => {
    const res = await appAs("me").request("/run", { method: "POST" });
    expect(res.status).toBe(200);
    await res.text();
    expect(runWorkspaceBackup).toHaveBeenCalledOnce();
    expect(runWorkspaceBackup.mock.calls[0]?.[0]).toMatchObject({ userId: "me" });
  });

  it("POST /restore/run rejects a traversal filename with 400 and never runs the restore", async () => {
    const res = await appAs("me").request("/restore/run", {
      method: "POST",
      headers: { "content-type": "application/json", "Confirm-Restore": "yes-i-know-what-this-does" },
      body: JSON.stringify({
        source: { kind: "local", filename: "workspace-../bob/workspace-bob-2026-05-20T00-00-00-000Z.tar.zst" },
      }),
    });
    expect(res.status).toBe(400);
    expect(runWorkspaceRestore).not.toHaveBeenCalled();
  });
});
