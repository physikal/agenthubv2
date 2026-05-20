# Unified Workspace Backup — Backend + CLI Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one server/CLI workspace-backup mechanism (sidecar volume snapshot → local-first, optional operator B2) the single way to back up `/home/coder`, triggerable manually (admin: any/all; user: own) and automatically before every update, with download + verified restore — and remove the redundant per-user agent-rclone path.

**Architecture:** Reuse the existing `services/workspace-backup/*` sidecar engine (bundler/restorer/runner already snapshot the `agenthub-home-{userId}` volume). Add exclude filters + per-user retention, repurpose the freed `backup_runs` table for history, expose admin + per-user HTTP routes mirroring `admin-install-backup.ts`, wire a best-effort `backup-workspace --all` into the CLI pre-update hook, and delete the agent rclone backup path. Web UI is Plan 2.

**Tech Stack:** TypeScript (Node 22, ESM), Hono, Drizzle (SQLite), vitest, Docker sidecar containers, rclone, bash CLI.

**Spec:** `docs/superpowers/specs/2026-05-20-unified-workspace-backup-design.md`

---

## File Structure

**Modify (engine):**
- `packages/server/src/services/workspace-backup/bundler.ts` — extract the sidecar shell command into a testable function; add `node_modules`/`.cache`/`.local` excludes.
- `packages/server/src/services/workspace-backup/types.ts` — add `"auto-update"` trigger.
- `packages/server/src/services/workspace-backup/manifest.ts` — accept `"auto-update"`.
- `packages/server/src/services/workspace-backup/runner.ts` — call retention after backup.

**Create:**
- `packages/server/src/services/workspace-backup/retention.ts` (+ `.test.ts`) — per-user prune.
- `packages/server/src/services/workspace-backup/history.ts` (+ `.test.ts`) — `backup_runs` start/finish helpers for workspace runs.
- `packages/server/src/routes/admin-workspace-backup.ts` (+ `.test.ts`) — admin routes.
- `packages/server/src/routes/user-workspace-backup.ts` (+ `.test.ts`) — per-user routes.

**Modify (wiring):**
- `packages/server/src/db/schema.ts` + `packages/server/src/db/index.ts` — add `local_path`, `b2_path`, `trigger` columns to `backup_runs`.
- `packages/server/src/index.ts` — mount the two new route apps.
- `scripts/agenthub` — add `backup_workspace_auto()` and call it in `cmd_update`.

**Remove (replace, don't deprecate):**
- `packages/agent/src/ws-server.ts` — `handleBackup`, `BackupParams`, `validateBackupParams`, `rcloneSize`, the `case "backup"` dispatch, and the `{type:"backup"}` union member.
- `packages/server/src/services/session-manager.ts` — `backupViaAgent` + its pending-request plumbing.
- `packages/server/src/routes/user.ts` — `/backup*` routes, `BackupConfig` + helpers, `toAgentParams`, old `startBackupRun`/`finishBackupRun` (replaced by `history.ts`).

---

## Phase A — Engine: excludes, retention, trigger

### Task 1: Make the bundler's sidecar command testable + add excludes

**Files:**
- Modify: `packages/server/src/services/workspace-backup/bundler.ts`
- Test: `packages/server/src/services/workspace-backup/bundler.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// bundler.test.ts
import { describe, it, expect } from "vitest";
import { buildBundleShellCommand, WORKSPACE_EXCLUDES } from "./bundler.js";

describe("buildBundleShellCommand", () => {
  it("writes the manifest first, then appends the volume with excludes", () => {
    const cmd = buildBundleShellCommand();
    // manifest header tar built before volume contents
    expect(cmd.indexOf("agenthub-workspace-manifest.json")).toBeLessThan(
      cmd.indexOf("-C /src"),
    );
    // every regenerable dir is excluded from the volume tar
    for (const ex of WORKSPACE_EXCLUDES) {
      expect(cmd).toContain(`--exclude=${ex}`);
    }
    // still streams through zstd to the destination
    expect(cmd).toContain('zstd -T0 -19');
  });

  it("excludes node_modules anywhere and .cache/.local at the home root", () => {
    expect(WORKSPACE_EXCLUDES).toContain("node_modules");
    expect(WORKSPACE_EXCLUDES).toContain("./.cache");
    expect(WORKSPACE_EXCLUDES).toContain("./.local");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run workspace-backup/bundler`
Expected: FAIL — `buildBundleShellCommand`/`WORKSPACE_EXCLUDES` not exported.

- [ ] **Step 3: Implement — extract the command + add excludes**

In `bundler.ts`, add near the top (after imports):

```typescript
/**
 * Regenerable dirs excluded from workspace snapshots. `node_modules` is
 * unanchored (matches the dir anywhere in the tree); `.cache`/`.local` are
 * anchored to the volume root (`/home/coder`). `.local` is the agenthub CLI
 * tree, auto-reinstalled by the agent on session boot.
 */
export const WORKSPACE_EXCLUDES = ["node_modules", "./.cache", "./.local"] as const;

/** The sidecar `sh -c` body. Pulled out as a pure function so the exclude
 * wiring is unit-testable without spawning Docker. */
export function buildBundleShellCommand(): string {
  const excludeFlags = WORKSPACE_EXCLUDES.map((e) => `--exclude=${e}`).join(" ");
  return [
    "set -eu",
    'mkdir -p "$SIDECAR_DEST" /work',
    "printf '%s' \"$MANIFEST_JSON\" > /work/agenthub-workspace-manifest.json",
    "(cd /work && tar c --warning=no-file-changed agenthub-workspace-manifest.json) > /tmp/header.tar",
    `tar -rf /tmp/header.tar -C /src --warning=no-file-changed ${excludeFlags} .`,
    'zstd -T0 -19 < /tmp/header.tar > "$SIDECAR_DEST/$BUNDLE_FILENAME"',
  ].join(" && ");
}
```

Then replace the inline array passed to `sh -c` in `bundleWorkspace` (currently the `[ "set -eu", … ].join(" && ")` block) with `buildBundleShellCommand()`:

```typescript
        SIDECAR_IMAGE,
        "sh",
        "-c",
        buildBundleShellCommand(),
      ],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agenthub/server exec vitest run workspace-backup/bundler`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @agenthub/server typecheck`
```bash
git add packages/server/src/services/workspace-backup/bundler.ts packages/server/src/services/workspace-backup/bundler.test.ts
git commit -m "feat(workspace-backup): exclude regenerable dirs from snapshots"
```

---

### Task 2: Per-user retention module

**Files:**
- Create: `packages/server/src/services/workspace-backup/retention.ts`
- Test: `packages/server/src/services/workspace-backup/retention.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// retention.test.ts
import { describe, it, expect } from "vitest";
import { pickBundlesToDelete } from "./retention.js";

const f = (ts: string) => `workspace-u1-${ts}.tar.zst`;

describe("pickBundlesToDelete", () => {
  it("keeps the newest N, returns the rest (oldest first)", () => {
    const names = [
      f("2026-05-01T00-00-00-000Z"),
      f("2026-05-03T00-00-00-000Z"),
      f("2026-05-02T00-00-00-000Z"),
    ];
    expect(pickBundlesToDelete(names, 2)).toEqual([f("2026-05-01T00-00-00-000Z")]);
  });

  it("returns [] when at or under the limit", () => {
    expect(pickBundlesToDelete([f("2026-05-01T00-00-00-000Z")], 10)).toEqual([]);
  });

  it("ignores non-bundle filenames", () => {
    expect(pickBundlesToDelete(["README.md", f("2026-05-01T00-00-00-000Z")], 0))
      .toEqual([f("2026-05-01T00-00-00-000Z")]);
  });

  it("keepLast<=0 deletes all bundles", () => {
    expect(pickBundlesToDelete([f("2026-05-01T00-00-00-000Z")], 0))
      .toEqual([f("2026-05-01T00-00-00-000Z")]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run workspace-backup/retention`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// retention.ts
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
    .sort(); // ISO timestamp in name => lexicographic == chronological
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

/** Prune a user's B2 workspace dir (<prefix>/workspaces/{userId}/). `cfg`
 * must already have its pathPrefix pointed at that per-user dir. */
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agenthub/server exec vitest run workspace-backup/retention`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/workspace-backup/retention.ts packages/server/src/services/workspace-backup/retention.test.ts
git commit -m "feat(workspace-backup): per-user retention pruning"
```

---

### Task 3: Add `auto-update` trigger

**Files:**
- Modify: `packages/server/src/services/workspace-backup/types.ts:22`
- Modify: `packages/server/src/services/workspace-backup/manifest.ts:7-11`
- Test: `packages/server/src/services/workspace-backup/manifest.test.ts` (create or extend)

- [ ] **Step 1: Write the failing test**

```typescript
// manifest.test.ts (add this case; create the file if absent with the import)
import { describe, it, expect } from "vitest";
import { parseWorkspaceManifest, serializeWorkspaceManifest } from "./manifest.js";

describe("parseWorkspaceManifest auto-update trigger", () => {
  it("accepts the auto-update trigger", () => {
    const json = serializeWorkspaceManifest({
      schemaVersion: 1,
      createdAt: "2026-05-20T00:00:00.000Z",
      userId: "u1",
      userEmail: null,
      workspaceImageSha: null,
      trigger: "auto-update",
    });
    expect(parseWorkspaceManifest(json).trigger).toBe("auto-update");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run workspace-backup/manifest`
Expected: FAIL — `"auto-update"` not assignable to `WorkspaceTrigger` / rejected by `VALID_TRIGGERS`.

- [ ] **Step 3: Implement**

`types.ts:22`:
```typescript
export type WorkspaceTrigger = "manual" | "cli" | "auto-update" | "auto-restore-install";
```

`manifest.ts:7-11`:
```typescript
const VALID_TRIGGERS = new Set<WorkspaceTrigger>([
  "manual",
  "cli",
  "auto-update",
  "auto-restore-install",
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agenthub/server exec vitest run workspace-backup/manifest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/workspace-backup/types.ts packages/server/src/services/workspace-backup/manifest.ts packages/server/src/services/workspace-backup/manifest.test.ts
git commit -m "feat(workspace-backup): add auto-update trigger"
```

---

### Task 4: Wire retention into `runWorkspaceBackup`

**Files:**
- Modify: `packages/server/src/services/workspace-backup/runner.ts`

- [ ] **Step 1: Add a keepLast input + prune calls**

In `WorkspaceBackupRunInput` add:
```typescript
  /** Bundles to keep per user; older ones are pruned after a successful
   * backup. <=0 disables pruning. Default 10. */
  keepLast?: number;
```

At the end of `runWorkspaceBackup`, after `b2Path` is set and before `return`:

```typescript
  const keepLast = input.keepLast ?? 10;
  if (keepLast > 0) {
    const localPruned = pruneWorkspaceLocal(dest, keepLast);
    if (localPruned.length > 0) input.onLog?.(`[ws-backup] pruned ${localPruned.length} old local bundle(s)`);
    if (input.b2) {
      const cfgForUser: B2Config = {
        ...input.b2,
        pathPrefix: `${input.b2.pathPrefix.replace(/\/+$/, "")}/workspaces/${input.userId}`,
      };
      try {
        const b2Pruned = await pruneWorkspaceB2(cfgForUser, keepLast);
        if (b2Pruned.length > 0) input.onLog?.(`[ws-backup] pruned ${b2Pruned.length} old B2 bundle(s)`);
      } catch (err) {
        input.onLog?.(`[ws-backup] B2 prune skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
```

Add the import at the top:
```typescript
import { pruneWorkspaceLocal, pruneWorkspaceB2 } from "./retention.js";
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @agenthub/server typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/services/workspace-backup/runner.ts
git commit -m "feat(workspace-backup): prune old bundles after backup"
```

---

## Phase B — History (repurpose `backup_runs`)

### Task 5: Add columns to `backup_runs`

**Files:**
- Modify: `packages/server/src/db/schema.ts:153-168`
- Modify: `packages/server/src/db/index.ts` (the `CREATE TABLE backup_runs` block + the `addColumnIfMissing` migration list)

- [ ] **Step 1: Extend the schema**

In `schema.ts` `backupRuns`, add after `error`:
```typescript
  localPath: text("local_path"),
  b2Path: text("b2_path"),
  trigger: text("trigger", { enum: ["manual", "cli", "auto-update"] }),
```

- [ ] **Step 2: Add idempotent migrations**

In `db/index.ts`, alongside the other `addColumnIfMissing(...)` migration calls, add:
```typescript
addColumnIfMissing("backup_runs", "local_path", "TEXT");
addColumnIfMissing("backup_runs", "b2_path", "TEXT");
addColumnIfMissing("backup_runs", "trigger", "TEXT");
```
(If the `CREATE TABLE backup_runs (...)` literal in `db/index.ts` lists columns explicitly, add the three columns there too so fresh installs match.)

- [ ] **Step 3: Typecheck + run existing db tests**

Run: `pnpm --filter @agenthub/server typecheck && pnpm --filter @agenthub/server exec vitest run db`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/db/schema.ts packages/server/src/db/index.ts
git commit -m "feat(db): add local_path/b2_path/trigger to backup_runs"
```

---

### Task 6: Workspace history helper

**Files:**
- Create: `packages/server/src/services/workspace-backup/history.ts`
- Test: `packages/server/src/services/workspace-backup/history.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// history.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { db, schema } from "../../db/index.js";
import { startWorkspaceRun, finishWorkspaceRun, listWorkspaceRuns } from "./history.js";
import { eq } from "drizzle-orm";

const USER = "hist-user-1";

beforeEach(() => {
  db.delete(schema.backupRuns).where(eq(schema.backupRuns.userId, USER)).run();
  // ensure FK user row exists
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run workspace-backup/history`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// history.ts
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import type { WorkspaceTrigger } from "./types.js";

type Kind = "save" | "restore";
type Status = "success" | "failed";
type HistoryTrigger = "manual" | "cli" | "auto-update";

function toHistoryTrigger(t: WorkspaceTrigger): HistoryTrigger {
  return t === "auto-restore-install" ? "cli" : t;
}

export function startWorkspaceRun(userId: string, kind: Kind, trigger: HistoryTrigger): string {
  const id = randomUUID();
  db.insert(schema.backupRuns)
    .values({ id, userId, kind, status: "running", startedAt: new Date(), trigger })
    .run();
  return id;
}

export function finishWorkspaceRun(
  id: string,
  status: Status,
  fields: { bytes?: number; localPath?: string; b2Path?: string | null; error?: string } = {},
): void {
  db.update(schema.backupRuns)
    .set({
      status,
      endedAt: new Date(),
      ...(fields.bytes !== undefined ? { bytes: fields.bytes } : {}),
      ...(fields.localPath !== undefined ? { localPath: fields.localPath } : {}),
      ...(fields.b2Path !== undefined ? { b2Path: fields.b2Path } : {}),
      ...(fields.error !== undefined ? { error: fields.error } : {}),
    })
    .where(eq(schema.backupRuns.id, id))
    .run();
}

export function listWorkspaceRuns(userId: string | null, limit = 50) {
  const base = db.select().from(schema.backupRuns);
  const q = userId
    ? base.where(eq(schema.backupRuns.userId, userId))
    : base;
  return q.orderBy(desc(schema.backupRuns.startedAt)).limit(limit).all();
}

export { toHistoryTrigger };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agenthub/server exec vitest run workspace-backup/history`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/workspace-backup/history.ts packages/server/src/services/workspace-backup/history.test.ts
git commit -m "feat(workspace-backup): backup_runs history helpers"
```

---

## Phase C — Web routes

> Both route files mirror `routes/admin-install-backup.ts` (SSE via `streamSSE` + a
> `safeWrite` helper emitting `log`/`done`/`error` events; downloads via
> `Readable.toWeb(createReadStream(...))`). Read that file as the reference.

### Task 7: Admin workspace-backup routes

**Files:**
- Create: `packages/server/src/routes/admin-workspace-backup.ts`
- Test: `packages/server/src/routes/admin-workspace-backup.test.ts`

- [ ] **Step 1: Write the failing test (auth scoping + list + run)**

```typescript
// admin-workspace-backup.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const runWorkspaceBackup = vi.fn(async () => ({ bundlePath: "/data/workspace-backups/u1/workspace-u1-2026-05-20T00-00-00-000Z.tar.zst", bytes: 10, b2Path: null, manifest: {} }));
vi.mock("../services/workspace-backup/runner.js", () => ({ runWorkspaceBackup, runWorkspaceRestore: vi.fn() }));
vi.mock("../services/install-backup/runner.js", () => ({ loadB2Config: vi.fn(async () => null) }));

import { adminWorkspaceBackupRoutes } from "./admin-workspace-backup.js";

function appWithUser() {
  const app = adminWorkspaceBackupRoutes();
  return app;
}

beforeEach(() => runWorkspaceBackup.mockClear());

describe("admin-workspace-backup", () => {
  it("POST /run with a userId invokes the runner for that user", async () => {
    const app = appWithUser();
    const res = await app.request("/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "u1" }),
    });
    expect(res.status).toBe(200); // SSE stream opened
    // drain the stream so the async work runs
    await res.text();
    expect(runWorkspaceBackup).toHaveBeenCalledOnce();
    expect(runWorkspaceBackup.mock.calls[0]?.[0]).toMatchObject({ userId: "u1", trigger: "manual" });
  });

  it("POST /run requires userId or all", async () => {
    const app = appWithUser();
    const res = await app.request("/run", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run admin-workspace-backup`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the routes**

```typescript
// admin-workspace-backup.ts
import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runWorkspaceBackup, runWorkspaceRestore } from "../services/workspace-backup/runner.js";
import { listWorkspaceRuns } from "../services/workspace-backup/history.js";
import { loadB2Config } from "../services/install-backup/runner.js";

const HOST_BACKUP_DIR = process.env["AGENTHUB_WORKSPACE_BACKUP_DIR"] ?? "/data/workspace-backups";
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_FILE = /^workspace-.+\.tar\.zst$/;

export function adminWorkspaceBackupRoutes() {
  const app = new Hono();

  // List run history; ?userId= filters to one user.
  app.get("/runs", (c) => {
    const userId = c.req.query("userId") ?? null;
    return c.json({ runs: listWorkspaceRuns(userId, 50) });
  });

  // Back up one user (userId) or everyone (all:true). SSE-streamed.
  app.post("/run", async (c) => {
    const body = await c.req.json<{ userId?: string; all?: boolean; noB2?: boolean; note?: string }>();
    if (!body.all && !body.userId) return c.json({ error: "userId or all required" }, 400);

    return streamSSE(c, async (stream) => {
      const write = (event: string, data: string) => { stream.writeSSE({ event, data }).catch(() => {}); };
      try {
        const cfg = body.noB2 ? null : await loadB2Config().catch(() => null);
        const users = body.all
          ? db.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).all()
          : db.select({ id: schema.users.id, username: schema.users.username })
              .from(schema.users).where(eq(schema.users.id, body.userId as string)).all();
        if (users.length === 0) { write("error", "no matching user"); return; }

        for (const u of users) {
          write("log", `[ws-backup] === ${u.username} (${u.id}) ===`);
          try {
            const r = await runWorkspaceBackup({
              userId: u.id, userEmail: u.username, workspaceImageSha: process.env["WORKSPACE_IMAGE_SHA"] ?? null,
              trigger: "manual", b2: cfg, ...(body.note ? { note: body.note } : {}),
              onLog: (l) => write("log", l),
            });
            write("log", `[ws-backup] ok: ${r.bundlePath} (${r.bytes} bytes)`);
          } catch (err) {
            write("log", `[ws-backup] FAILED ${u.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        write("done", JSON.stringify({ count: users.length }));
      } catch (err) {
        write("error", err instanceof Error ? err.message : "unknown");
      }
    });
  });

  // Download a user's local bundle.
  app.get("/download/:userId/:filename", (c) => {
    const userId = c.req.param("userId");
    const filename = c.req.param("filename");
    if (!SAFE_ID.test(userId) || !SAFE_FILE.test(filename)) return c.json({ error: "bad path" }, 400);
    const path = join(HOST_BACKUP_DIR, userId, filename);
    if (!existsSync(path)) return c.json({ error: "not found" }, 404);
    const stat = statSync(path);
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": "application/zstd",
        "Content-Length": String(stat.size),
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  });

  // Restore a user from a B2 snapshot or a local on-disk bundle. SSE-streamed.
  app.post("/restore/run", async (c) => {
    if (c.req.header("Confirm-Restore") !== "yes-i-know-what-this-does") {
      return c.json({ error: "missing Confirm-Restore header" }, 403);
    }
    const body = await c.req.json<{
      userId: string;
      source: { kind: "b2-snapshot"; snapshot: "latest" | string } | { kind: "local"; filename: string };
      force?: boolean;
    }>();
    if (!body.userId || !SAFE_ID.test(body.userId)) return c.json({ error: "userId required" }, 400);

    return streamSSE(c, async (stream) => {
      const write = (event: string, data: string) => { stream.writeSSE({ event, data }).catch(() => {}); };
      try {
        const cfg = await loadB2Config().catch(() => null);
        const restoreInput: Parameters<typeof runWorkspaceRestore>[0] = {
          userId: body.userId, b2: cfg, force: body.force ?? false, onLog: (l) => write("log", l),
        };
        if (body.source.kind === "b2-snapshot") restoreInput.b2Snapshot = body.source.snapshot;
        else {
          if (!SAFE_FILE.test(body.source.filename)) { write("error", "bad filename"); return; }
          restoreInput.localBundlePath = join(HOST_BACKUP_DIR, body.userId, body.source.filename);
        }
        const r = await runWorkspaceRestore(restoreInput);
        write("done", JSON.stringify(r));
      } catch (err) {
        write("error", err instanceof Error ? err.message : "unknown");
      }
    });
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agenthub/server exec vitest run admin-workspace-backup`
Expected: PASS.

- [ ] **Step 5: Mount in `index.ts` + typecheck**

Add import near the other route imports and mount after install-backup (line ~199):
```typescript
import { adminWorkspaceBackupRoutes } from "./routes/admin-workspace-backup.js";
// ...
app.route("/api/admin/workspace-backup", adminWorkspaceBackupRoutes());
```
Run: `pnpm --filter @agenthub/server typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes/admin-workspace-backup.ts packages/server/src/routes/admin-workspace-backup.test.ts packages/server/src/index.ts
git commit -m "feat(workspace-backup): admin routes (run/list/download/restore)"
```

---

### Task 8: Per-user workspace-backup routes

**Files:**
- Create: `packages/server/src/routes/user-workspace-backup.ts`
- Test: `packages/server/src/routes/user-workspace-backup.test.ts`

These run scoped to the authenticated `user.id` (never a client-supplied id). Backup
runs anytime (sidecar mounts the volume read-only). Restore-own enforces the existing
active-session guard inside `runWorkspaceRestore` (it throws if the user has a live
session) and requires the `Confirm-Restore` header.

- [ ] **Step 1: Write the failing test**

```typescript
// user-workspace-backup.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const runWorkspaceBackup = vi.fn(async () => ({ bundlePath: "/data/workspace-backups/me/workspace-me-2026-05-20T00-00-00-000Z.tar.zst", bytes: 5, b2Path: null, manifest: {} }));
vi.mock("../services/workspace-backup/runner.js", () => ({ runWorkspaceBackup, runWorkspaceRestore: vi.fn() }));
vi.mock("../services/install-backup/runner.js", () => ({ loadB2Config: vi.fn(async () => null) }));

import { Hono } from "hono";
import { userWorkspaceBackupRoutes } from "./user-workspace-backup.js";

function appAs(userId: string) {
  const outer = new Hono();
  outer.use("*", async (c, next) => { c.set("user", { id: userId, username: "me", role: "user" }); await next(); });
  outer.route("/", userWorkspaceBackupRoutes());
  return outer;
}

beforeEach(() => runWorkspaceBackup.mockClear());

describe("user-workspace-backup", () => {
  it("POST /run backs up the authenticated user only", async () => {
    const res = await appAs("me").request("/run", { method: "POST" });
    expect(res.status).toBe(200);
    await res.text();
    expect(runWorkspaceBackup.mock.calls[0]?.[0]).toMatchObject({ userId: "me" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run user-workspace-backup`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// user-workspace-backup.ts
import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AuthUser } from "../middleware/auth.js";
import { runWorkspaceBackup, runWorkspaceRestore } from "../services/workspace-backup/runner.js";
import { listWorkspaceRuns } from "../services/workspace-backup/history.js";
import { loadB2Config } from "../services/install-backup/runner.js";

const HOST_BACKUP_DIR = process.env["AGENTHUB_WORKSPACE_BACKUP_DIR"] ?? "/data/workspace-backups";
const SAFE_FILE = /^workspace-.+\.tar\.zst$/;

export function userWorkspaceBackupRoutes() {
  const app = new Hono<{ Variables: { user: AuthUser } }>();

  app.get("/", (c) => c.json({ runs: listWorkspaceRuns(c.get("user").id, 50) }));

  app.post("/run", async (c) => {
    const user = c.get("user");
    return streamSSE(c, async (stream) => {
      const write = (event: string, data: string) => { stream.writeSSE({ event, data }).catch(() => {}); };
      try {
        const cfg = await loadB2Config().catch(() => null);
        const r = await runWorkspaceBackup({
          userId: user.id, userEmail: user.username ?? null,
          workspaceImageSha: process.env["WORKSPACE_IMAGE_SHA"] ?? null,
          trigger: "manual", b2: cfg, onLog: (l) => write("log", l),
        });
        write("done", JSON.stringify({ bundlePath: r.bundlePath, bytes: r.bytes }));
      } catch (err) {
        write("error", err instanceof Error ? err.message : "unknown");
      }
    });
  });

  app.get("/download/:filename", (c) => {
    const filename = c.req.param("filename");
    if (!SAFE_FILE.test(filename)) return c.json({ error: "bad filename" }, 400);
    const path = join(HOST_BACKUP_DIR, c.get("user").id, filename);
    if (!existsSync(path)) return c.json({ error: "not found" }, 404);
    const stat = statSync(path);
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": "application/zstd",
        "Content-Length": String(stat.size),
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  });

  app.post("/restore/run", async (c) => {
    if (c.req.header("Confirm-Restore") !== "yes-i-know-what-this-does") {
      return c.json({ error: "missing Confirm-Restore header" }, 403);
    }
    const user = c.get("user");
    const body = await c.req.json<{
      source: { kind: "b2-snapshot"; snapshot: "latest" | string } | { kind: "local"; filename: string };
      force?: boolean;
    }>();
    return streamSSE(c, async (stream) => {
      const write = (event: string, data: string) => { stream.writeSSE({ event, data }).catch(() => {}); };
      try {
        const cfg = await loadB2Config().catch(() => null);
        const input: Parameters<typeof runWorkspaceRestore>[0] = {
          userId: user.id, b2: cfg, force: body.force ?? false, onLog: (l) => write("log", l),
        };
        if (body.source.kind === "b2-snapshot") input.b2Snapshot = body.source.snapshot;
        else {
          if (!SAFE_FILE.test(body.source.filename)) { write("error", "bad filename"); return; }
          input.localBundlePath = join(HOST_BACKUP_DIR, user.id, body.source.filename);
        }
        // runWorkspaceRestore throws if the user has an active session.
        const r = await runWorkspaceRestore(input);
        write("done", JSON.stringify(r));
      } catch (err) {
        write("error", err instanceof Error ? err.message : "unknown");
      }
    });
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agenthub/server exec vitest run user-workspace-backup`
Expected: PASS.

- [ ] **Step 5: Mount in `index.ts` (under the auth middleware, with the other `/api/user` routes ~line 173) + typecheck**

```typescript
import { userWorkspaceBackupRoutes } from "./routes/user-workspace-backup.js";
// ...
app.route("/api/user/workspace-backup", userWorkspaceBackupRoutes());
```
Run: `pnpm --filter @agenthub/server typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes/user-workspace-backup.ts packages/server/src/routes/user-workspace-backup.test.ts packages/server/src/index.ts
git commit -m "feat(workspace-backup): per-user backup/restore/download routes"
```

---

## Phase D — Pre-update hook

### Task 9: Auto-backup all workspaces before update

**Files:**
- Modify: `scripts/agenthub` (`cmd_update` near line 465; add `backup_workspace_auto` near `backup_install_auto` ~line 613)

- [ ] **Step 1: Add the helper**

After `backup_install_auto()` (around line 623), add:
```bash
# Best-effort workspace backup of every user before an update. Never aborts
# the update — per-user failures inside backup-workspace are already
# swallowed, and a non-zero exit here is logged and ignored.
backup_workspace_auto() {
  local ctr
  ctr="$(server_container_name)"
  if ! $SUDO docker inspect "$ctr" --format '{{.State.Running}}' 2>/dev/null | grep -q 'true'; then
    warn "server container not running — skipping workspace auto-backup"
    return 0
  fi
  msg "backing up all user workspaces before update (best-effort)"
  cmd_backup_workspace --all --note "auto-backup before update" || \
    warn "workspace auto-backup reported failures — continuing update"
}
```

- [ ] **Step 2: Call it in `cmd_update`**

In `cmd_update` immediately after the `if ! backup_install_auto; then ... fi` block (line ~465-467), add:
```bash
  backup_workspace_auto || true
```

- [ ] **Step 3: Lint the script**

Run: `shellcheck scripts/agenthub && shfmt -d scripts/agenthub`
Expected: no errors (match existing style; fix any new warnings).

- [ ] **Step 4: Commit**

```bash
git add scripts/agenthub
git commit -m "feat(cli): back up all workspaces before update (best-effort)"
```

---

## Phase E — Remove the redundant per-user rclone path

### Task 10: Strip backup from the agent daemon

**Files:**
- Modify: `packages/agent/src/ws-server.ts` (remove `BackupParams` iface ~22, the `{type:"backup"}` union member ~36, `validateBackupParams` ~67, the `case "backup"` dispatch ~145-146, `handleBackup` ~202-293, `rcloneSize` ~295-309)
- Modify: `packages/agent/src/ws-server.test.ts` (drop backup cases) and any `*.test.ts` referencing backup

- [ ] **Step 1: Find references**

Run: `rg -n "BackupParams|validateBackupParams|handleBackup|rcloneSize|\"backup\"" packages/agent/src`
Expected: only `ws-server.ts` (+ its test).

- [ ] **Step 2: Delete the members listed above.** Remove the now-unused imports (`execFileAsync` if only backup used it — verify with `rg "execFileAsync" packages/agent/src/ws-server.ts` first; keep if other handlers use it).

- [ ] **Step 3: Update/trim the agent tests** to drop backup expectations.

- [ ] **Step 4: Typecheck + test the agent**

Run: `pnpm --filter @agenthub/agent typecheck && pnpm --filter @agenthub/agent test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/ws-server.ts packages/agent/src/ws-server.test.ts
git commit -m "refactor(agent): remove in-workspace rclone backup path"
```

---

### Task 11: Remove `backupViaAgent` + per-user backup routes

**Files:**
- Modify: `packages/server/src/services/session-manager.ts` (remove `backupViaAgent` ~756 + the backup pending-request map/handler it relies on — verify nothing else uses that map)
- Modify: `packages/server/src/routes/user.ts` (remove `/backup` GET/PUT/DELETE ~224-288, `/backup/status|save|restore` ~292-380, `BackupConfig` + `legacyBackupPath` + `validateBackupConfig` + `getBackupConfig` + `setBackupConfig` + `deleteBackupConfig` + `toAgentParams` ~29-220, and the old `startBackupRun`/`finishBackupRun` ~170-204; the `BackupParams`/`BackupResult` imports ~21-22)

- [ ] **Step 1: Confirm no remaining consumers**

Run: `rg -n "backupViaAgent|toAgentParams|getBackupConfig|setBackupConfig|/backup" packages/server/src packages/web/src`
Expected after edits: web references are Plan-2 territory (the old Backups page) — note them but don't edit web here; server references should be gone.

- [ ] **Step 2: Delete the members above.** Keep `getUsername` and any helper still used elsewhere (grep before deleting). The `backup_runs` writes now live in `history.ts` (Task 6) — delete the duplicate `startBackupRun`/`finishBackupRun` in `user.ts`.

- [ ] **Step 3: Typecheck + server tests**

Run: `pnpm --filter @agenthub/server typecheck && pnpm --filter @agenthub/server test`
Expected: PASS (any user.ts backup tests removed/updated).

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/services/session-manager.ts packages/server/src/routes/user.ts
git commit -m "refactor(server): remove per-user agent backup routes + helpers"
```

---

### Task 12: Verify + handle the orphaned per-user B2 config (open item)

**Files:** investigation; possibly `packages/server/src/routes/infra.ts`, `db`

- [ ] **Step 1: Determine whether the per-user `provider='b2'` infra row has any consumer other than the removed backup path.**

Run: `rg -n "'b2'|\"b2\"|provider.*b2|getBackupConfig|legacyBackupPath" packages/server/src`
Confirm `install-backup`'s `loadB2Config()` reads its OWN config row (not the per-user infra `b2` row). The operator B2 used by workspace backup must be independent of any per-user `b2` row.

- [ ] **Step 2: Decision (record in commit message):**
  - If `b2` infra rows are now unused server-side → leave the provider enum in place but note the UI removal happens in Plan 2 (the Backups page rework). Do NOT drop the DB enum value (existing rows may persist).
  - If `loadB2Config()` depends on a per-user row → STOP and flag; the design assumed operator-level B2. Reconcile before proceeding.

- [ ] **Step 3: Commit any doc note**

```bash
git commit --allow-empty -m "chore(workspace-backup): confirm operator B2 independent of per-user b2 row"
```

---

## Phase F — End-to-end verification

### Task 13: Backup → restore round-trip (the "it works" proof)

**Files:**
- Create: `scripts/e2e-workspace-backup.js` (run inside the server container, like `scripts/e2e-full.js`)

- [ ] **Step 1: Write the E2E script**

The script (run via `docker exec ... node /tmp/e2e-ws.js`) must, for a throwaway test user with an `agenthub-home-{userId}` volume:
1. Seed files: write `/home/coder/project/app.txt` (content "hello") and a dummy `/home/coder/project/node_modules/dep.txt` into the volume (via a one-shot `docker run -v vol:/home/coder alpine sh -c '...'`).
2. `runWorkspaceBackup({ userId, trigger:"manual", b2:null, ... })` (local-only).
3. Assert a bundle exists under `/data/workspace-backups/{userId}/`.
4. Wipe the volume (`dockerVolumeRemove`).
5. `runWorkspaceRestore({ userId, localBundlePath:<bundle>, force:true })`.
6. Assert `/home/coder/project/app.txt` == "hello" AND `/home/coder/project/node_modules/dep.txt` is ABSENT (excluded).
7. Clean up the volume + bundle.

```javascript
// scripts/e2e-workspace-backup.js — sketch; fill paths from the modules above
import { runWorkspaceBackup, runWorkspaceRestore } from "/app/packages/server/dist/services/workspace-backup/runner.js";
import { dockerVolumeRemove, dockerVolumeCreate, volumeNameForUser } from "/app/packages/server/dist/services/workspace-backup/volume.js";
import { execFileSync } from "node:child_process";
// 1) seed, 2) backup, 3) assert bundle, 4) wipe, 5) restore, 6) assert content + node_modules absent
// throw on any assertion failure; print "E2E OK" on success
```

- [ ] **Step 2: Run it on a Docker host**

Run:
```bash
docker cp scripts/e2e-workspace-backup.js agenthub-agenthub-server-1:/tmp/e2e-ws.js
docker exec agenthub-agenthub-server-1 node /tmp/e2e-ws.js
```
Expected: prints `E2E OK`; app.txt restored, node_modules absent.

- [ ] **Step 3: Smoke-test install-backup restore still works** (regression): run `agenthub backup-install --local-only` then `agenthub restore-install --from <bundle> --dry-run` and confirm it reports a valid plan.

- [ ] **Step 4: Commit**

```bash
git add scripts/e2e-workspace-backup.js
git commit -m "test(workspace-backup): e2e backup/restore round-trip"
```

---

## Self-Review

**Spec coverage:**
- Decision 2 (sidecar single mechanism) → Tasks 1,4,7,8 + removals 10,11. ✓
- Decision 3 (pre-update, all users, best-effort) → Task 9. ✓
- Decision 4 (excludes) → Task 1. ✓
- Decision 5 (admin + per-user button) → Tasks 7,8. ✓
- Decision 6 (B2 optional, local-first, download) → engine already local-first; `noB2`/`loadB2Config` + download endpoints in Tasks 7,8. ✓
- Decision 7 (restore everywhere + verified) → Tasks 7,8 restore endpoints + Task 13 E2E. ✓
- Retention → Tasks 2,4. History → Tasks 5,6. Open item (per-user b2 row) → Task 12. ✓
- **UI (admin card + Backups page rework) → Plan 2 (not in this plan).**

**Type consistency:** `runWorkspaceBackup`/`runWorkspaceRestore` inputs match `runner.ts` (`WorkspaceBackupRunInput` gains `keepLast?`; restore via `localBundlePath`/`b2Snapshot`). History: `startWorkspaceRun(userId,kind,trigger)` / `finishWorkspaceRun(id,status,fields)` / `listWorkspaceRuns(userId|null,limit)` used consistently in Tasks 7,8. Trigger `"auto-update"` added in Task 3, used by Task 9's CLI note (CLI passes `trigger:"cli"` already; the `auto-update` value is available for future use and the manifest accepts it).

**Placeholder scan:** none — all new logic has concrete code; route boilerplate explicitly mirrors the named reference file.

**Open dependency:** Task 12 may surface that `loadB2Config()` is coupled to a per-user row (design assumes operator-level). If so, stop and reconcile before Task 9 relies on it.
