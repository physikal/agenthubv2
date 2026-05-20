import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkspaceBackupRunInput } from "../services/workspace-backup/runner.js";

const { runWorkspaceBackup } = vi.hoisted(() => ({
  runWorkspaceBackup: vi.fn<(input: WorkspaceBackupRunInput) => Promise<{ bundlePath: string; bytes: number; b2Path: null; manifest: object }>>(async () => ({ bundlePath: "/data/workspace-backups/u1/workspace-u1-2026-05-20T00-00-00-000Z.tar.zst", bytes: 10, b2Path: null, manifest: {} })),
}));
vi.mock("../services/workspace-backup/runner.js", () => ({ runWorkspaceBackup, runWorkspaceRestore: vi.fn() }));
vi.mock("../services/install-backup/runner.js", () => ({ loadB2Config: vi.fn(async () => null) }));

import { adminWorkspaceBackupRoutes } from "./admin-workspace-backup.js";

beforeEach(() => runWorkspaceBackup.mockClear());

describe("admin-workspace-backup", () => {
  it("POST /run with a userId invokes the runner for that user", async () => {
    const app = adminWorkspaceBackupRoutes();
    const res = await app.request("/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "u1" }),
    });
    expect(res.status).toBe(200);
    await res.text(); // drain SSE so async work runs
    expect(runWorkspaceBackup).toHaveBeenCalledOnce();
    expect(runWorkspaceBackup.mock.calls[0]?.[0]).toMatchObject({ userId: "u1", trigger: "manual" });
  });

  it("POST /run requires userId or all", async () => {
    const app = adminWorkspaceBackupRoutes();
    const res = await app.request("/run", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /restore/run rejects a missing source with 400", async () => {
    const app = adminWorkspaceBackupRoutes();
    const res = await app.request("/restore/run", {
      method: "POST",
      headers: { "content-type": "application/json", "Confirm-Restore": "yes-i-know-what-this-does" },
      body: JSON.stringify({ userId: "u1" }),
    });
    expect(res.status).toBe(400);
  });
});
