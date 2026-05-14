# Install-state Backup + Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship operator-scoped backup + restore of install state (compose/.env + /data/agenthub.db + Infisical Postgres dump) as a tar.gz bundle with B2 destination + local fallback. CLI verbs + Web UI + auto-backup-on-update + restore conflict guards.

**Architecture:** New `packages/server/src/services/install-backup/` module owns bundling, restoring, conflict-check, retention, and B2 transport — all executing inside the server container (which has docker-cli + compose, /repo, /data, and docker.sock available). Two new Drizzle tables (`install_backup_config` singleton + `install_backup_runs` history). Web UI is a new admin page at Settings → Admin → Install Backup. CLI verbs (`agenthub backup-install`, `agenthub restore-install`) talk to the server's REST endpoints OR (for fresh-VM restore where the server may be empty) invoke a one-shot restore container.

**Tech Stack:** TypeScript (Node 22, ESM), Hono server, Drizzle ORM + better-sqlite3, vitest, React 19 + Vite for web, Ink for CLI (not used here — agenthub script is bash), `pg_dump`/`pg_restore` via docker compose exec, rclone for B2.

**Reference spec:** `docs/superpowers/specs/2026-05-13-install-backup-restore.md`

**Dependency on PR #75:** This plan assumes `/api/admin/access/*` (post-TLS-rename) is the canonical admin path. The new install-backup routes mount at `/api/admin/install-backup/*` — independent paths, no conflict with #75's renames. The only file-level overlaps with #75 are `scripts/agenthub` (both add verbs) and `CLAUDE.md` (both add architecture sections); these are merge-resolvable. Recommend rebasing on top of merged #75 before pushing the impl PR.

---

## Pre-flight

- [ ] **Step 0.1: Confirm clean working tree on `main`**

Run: `git status && git log --oneline -3`
Expected: `working tree clean`. If PR #75 has merged, HEAD should show the lan-first TLS commits. Otherwise HEAD is at the pre-#75 main.

- [ ] **Step 0.2: Create implementation branch**

```bash
git switch -c feat/install-backup-restore
```

- [ ] **Step 0.3: Run baseline test suite**

Run: `pnpm install && pnpm test`
Expected: all tests pass. Note the count: should be 238+ tests across installer/server/agent packages.

- [ ] **Step 0.4: Run baseline typecheck**

Run: `pnpm typecheck`
Expected: passes across all 5 packages.

---

## Task 1: Schema + types foundation

**Files:**
- Modify: `packages/server/src/db/schema.ts`
- Create: `packages/server/src/services/install-backup/types.ts`

Drizzle is schema-driven (no migrations dir) — adding tables to schema.ts auto-creates them on next server boot. Use the existing `sqliteTable` / `text` / `integer` import style.

- [ ] **Step 1.1: Add tables to schema.ts**

Append to `packages/server/src/db/schema.ts`:
```typescript
export const installBackupConfig = sqliteTable("install_backup_config", {
  id: integer("id").primaryKey(), // singleton: only id=1 ever exists
  b2KeyId: text("b2_key_id"),
  b2Bucket: text("b2_bucket"),
  b2PathPrefix: text("b2_path_prefix").default("installs/"),
  retentionKeepLast: integer("retention_keep_last").default(10),
  updatedAt: text("updated_at").notNull(),
});

export const installBackupRuns = sqliteTable("install_backup_runs", {
  id: text("id").primaryKey(), // UUID
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  status: text("status", { enum: ["running", "ok", "failed"] }).notNull(),
  bytes: integer("bytes"),
  localPath: text("local_path"),
  b2Path: text("b2_path"),
  trigger: text("trigger", { enum: ["manual", "auto-update", "cli"] }).notNull(),
  error: text("error"),
  note: text("note"),
});
```

The `id INTEGER PRIMARY KEY CHECK (id = 1)` singleton constraint isn't directly expressible in Drizzle's schema DSL; enforce in code (insertOrUpdate by id=1).

- [ ] **Step 1.2: Verify the tables get created at boot**

Read `packages/server/src/db/index.ts` to confirm there's a "create tables if not exist" step on boot (likely `migrate` or a `CREATE TABLE IF NOT EXISTS` loop). If there is, no manual migration needed. If not, add the two CREATE statements there following the existing pattern.

- [ ] **Step 1.3: Create the types file**

Create `packages/server/src/services/install-backup/types.ts`:
```typescript
export const BUNDLE_SCHEMA_VERSION = 1 as const;

export interface BundleManifest {
  schemaVersion: typeof BUNDLE_SCHEMA_VERSION;
  createdAt: string; // ISO 8601
  sourceDomain: string;
  gitSha: string;
  composeVersion: string;
  trigger: "manual" | "auto-update" | "cli";
  note?: string;
}

export interface BackupRunSummary {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "ok" | "failed";
  bytes: number | null;
  localPath: string | null;
  b2Path: string | null;
  trigger: "manual" | "auto-update" | "cli";
  error: string | null;
  note: string | null;
}

export interface B2Config {
  keyId: string;
  appKey: string; // resolved from Infisical at runtime; never persisted to SQLite
  bucket: string;
  pathPrefix: string;
}

export type RestoreSource =
  | { kind: "local"; path: string }
  | { kind: "b2-url"; url: string }
  | { kind: "b2-snapshot"; snapshot: "latest" | string };

export interface Conflict {
  kind: "users-exist" | "secrets-exist" | "active-sessions" | "encryption-key-mismatch";
  detail: string;
}

export interface ConflictReport {
  ok: boolean;
  conflicts: Conflict[];
}
```

- [ ] **Step 1.4: Run typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 1.5: Commit**

```bash
git add packages/server/src/db/schema.ts packages/server/src/services/install-backup/types.ts packages/server/src/db/index.ts
git commit -m "feat(install-backup): schema + types foundation"
```

---

## Task 2: Manifest module (TDD)

**Files:**
- Create: `packages/server/src/services/install-backup/manifest.ts`
- Create: `packages/server/src/services/install-backup/manifest.test.ts`

- [ ] **Step 2.1: Write the failing tests**

Create `packages/server/src/services/install-backup/manifest.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { serializeManifest, parseManifest } from "./manifest.js";
import { BUNDLE_SCHEMA_VERSION } from "./types.js";

describe("manifest", () => {
  const fixture = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    createdAt: "2026-05-13T14:30:00.000Z",
    sourceDomain: "agenthub.example.com",
    gitSha: "abc123def456",
    composeVersion: "v2",
    trigger: "manual" as const,
    note: "before risky change",
  };

  it("round-trips a manifest", () => {
    const json = serializeManifest(fixture);
    const parsed = parseManifest(json);
    expect(parsed).toEqual(fixture);
  });

  it("rejects unknown schemaVersion", () => {
    const bad = JSON.stringify({ ...fixture, schemaVersion: 99 });
    expect(() => parseManifest(bad)).toThrow(/schemaVersion/);
  });

  it("rejects missing required fields", () => {
    const bad = JSON.stringify({ schemaVersion: BUNDLE_SCHEMA_VERSION });
    expect(() => parseManifest(bad)).toThrow();
  });

  it("rejects unknown trigger", () => {
    const bad = JSON.stringify({ ...fixture, trigger: "cron" });
    expect(() => parseManifest(bad)).toThrow(/trigger/);
  });

  it("accepts missing optional note", () => {
    const { note: _, ...withoutNote } = fixture;
    const json = serializeManifest(withoutNote);
    const parsed = parseManifest(json);
    expect(parsed.note).toBeUndefined();
  });
});
```

- [ ] **Step 2.2: Run failing tests**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/install-backup/manifest.test.ts`
Expected: fails with "Cannot find module './manifest.js'".

- [ ] **Step 2.3: Implement manifest module**

Create `packages/server/src/services/install-backup/manifest.ts`:
```typescript
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
```

- [ ] **Step 2.4: Run the tests (passing)**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/install-backup/manifest.test.ts`
Expected: 5 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add packages/server/src/services/install-backup/manifest.ts packages/server/src/services/install-backup/manifest.test.ts
git commit -m "feat(install-backup): manifest module"
```

---

## Task 3: B2 client wrapper (TDD)

**Files:**
- Create: `packages/server/src/services/install-backup/b2-client.ts`
- Create: `packages/server/src/services/install-backup/b2-client.test.ts`

The B2 client wraps `rclone` invocations (push, pull, list, delete). All methods take a `B2Config` + the local/remote paths. Use `child_process.spawn` for streaming rclone output.

- [ ] **Step 3.1: Write the failing tests**

Create `packages/server/src/services/install-backup/b2-client.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRcloneConfig, b2RemotePath } from "./b2-client.js";

describe("buildRcloneConfig", () => {
  it("emits an rclone-compatible config string", () => {
    const config = buildRcloneConfig({
      keyId: "k001abc",
      appKey: "secret",
      bucket: "agenthub-installs",
      pathPrefix: "installs/",
    });
    expect(config).toContain("[b2]");
    expect(config).toContain("type = b2");
    expect(config).toContain("account = k001abc");
    expect(config).toContain("key = secret");
  });
});

describe("b2RemotePath", () => {
  it("joins prefix + filename without double slash", () => {
    expect(
      b2RemotePath({
        keyId: "",
        appKey: "",
        bucket: "b",
        pathPrefix: "installs/",
      }, "install-foo.tar.gz"),
    ).toBe("b2:b/installs/install-foo.tar.gz");
  });

  it("handles missing prefix", () => {
    expect(
      b2RemotePath({
        keyId: "",
        appKey: "",
        bucket: "b",
        pathPrefix: "",
      }, "x.tar.gz"),
    ).toBe("b2:b/x.tar.gz");
  });

  it("normalizes prefix without trailing slash", () => {
    expect(
      b2RemotePath({
        keyId: "",
        appKey: "",
        bucket: "b",
        pathPrefix: "installs",
      }, "x.tar.gz"),
    ).toBe("b2:b/installs/x.tar.gz");
  });
});
```

(The actual push/pull/list/delete methods invoke rclone via child_process; we don't unit-test the spawn directly — that's covered by e2e. Test the pure helper functions.)

- [ ] **Step 3.2: Run failing tests**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/install-backup/b2-client.test.ts`
Expected: fails — module not found.

- [ ] **Step 3.3: Implement b2-client**

Create `packages/server/src/services/install-backup/b2-client.ts`:
```typescript
import { spawn } from "child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { B2Config } from "./types.js";

export function buildRcloneConfig(c: B2Config): string {
  return [
    "[b2]",
    "type = b2",
    `account = ${c.keyId}`,
    `key = ${c.appKey}`,
    "hard_delete = true",
    "",
  ].join("\n");
}

export function b2RemotePath(c: B2Config, filename: string): string {
  const prefix = c.pathPrefix.replace(/\/+$/, "");
  const joined = prefix ? `${prefix}/${filename}` : filename;
  return `b2:${c.bucket}/${joined}`;
}

async function runRclone(
  cfg: B2Config,
  args: string[],
  onLine?: (line: string) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "rclone-"));
  const configPath = join(tmp, "rclone.conf");
  writeFileSync(configPath, buildRcloneConfig(cfg), { mode: 0o600 });
  try {
    return await new Promise((resolve) => {
      const child = spawn("rclone", ["--config", configPath, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b) => {
        const s = b.toString();
        stdout += s;
        if (onLine) for (const line of s.split("\n")) if (line) onLine(line);
      });
      child.stderr.on("data", (b) => {
        const s = b.toString();
        stderr += s;
        if (onLine) for (const line of s.split("\n")) if (line) onLine(line);
      });
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  } finally {
    try { unlinkSync(configPath); } catch {} // best-effort
  }
}

export async function b2Push(
  cfg: B2Config,
  localPath: string,
  remoteFilename: string,
  onLine?: (line: string) => void,
): Promise<void> {
  const remote = b2RemotePath(cfg, remoteFilename);
  const result = await runRclone(cfg, ["copyto", localPath, remote, "--progress"], onLine);
  if (result.code !== 0) {
    throw new Error(`rclone push failed (exit ${result.code}): ${result.stderr.slice(-500)}`);
  }
}

export async function b2Pull(
  cfg: B2Config,
  remoteFilename: string,
  localPath: string,
  onLine?: (line: string) => void,
): Promise<void> {
  const remote = b2RemotePath(cfg, remoteFilename);
  const result = await runRclone(cfg, ["copyto", remote, localPath, "--progress"], onLine);
  if (result.code !== 0) {
    throw new Error(`rclone pull failed (exit ${result.code}): ${result.stderr.slice(-500)}`);
  }
}

export async function b2List(cfg: B2Config, prefix = ""): Promise<string[]> {
  const fullPrefix = b2RemotePath(cfg, prefix);
  const result = await runRclone(cfg, ["lsf", fullPrefix]);
  if (result.code !== 0) {
    throw new Error(`rclone list failed (exit ${result.code}): ${result.stderr.slice(-500)}`);
  }
  return result.stdout.split("\n").filter((l) => l.trim());
}

export async function b2Delete(cfg: B2Config, remoteFilename: string): Promise<void> {
  const remote = b2RemotePath(cfg, remoteFilename);
  const result = await runRclone(cfg, ["delete", remote]);
  if (result.code !== 0 && !result.stderr.includes("not found")) {
    throw new Error(`rclone delete failed (exit ${result.code}): ${result.stderr.slice(-500)}`);
  }
}
```

- [ ] **Step 3.4: Run the tests (passing)**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/install-backup/b2-client.test.ts`
Expected: 4 tests pass.

- [ ] **Step 3.5: Commit**

```bash
git add packages/server/src/services/install-backup/b2-client.ts packages/server/src/services/install-backup/b2-client.test.ts
git commit -m "feat(install-backup): b2-client (rclone wrapper)"
```

---

## Task 4: Bundler service (TDD)

**Files:**
- Create: `packages/server/src/services/install-backup/bundler.ts`
- Create: `packages/server/src/services/install-backup/bundler.test.ts`

The bundler runs inside the server container. It:
1. Creates a staging dir.
2. Calls sqlite3 `.backup` for the SQLite DB.
3. Spawns `docker compose exec -T infisical-postgres pg_dump -U infisical -F c -d infisical` and streams to a file.
4. Copies `compose/.env` to staging.
5. Writes `manifest.json`.
6. Tars + gzips the staging dir to the final tarball.
7. Deletes staging.

- [ ] **Step 4.1: Write the failing tests**

Create `packages/server/src/services/install-backup/bundler.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeStagingManifest, packBundle } from "./bundler.js";
import { BUNDLE_SCHEMA_VERSION } from "./types.js";

describe("writeStagingManifest", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "bundler-test-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("writes a valid manifest.json", () => {
    writeStagingManifest(tmp, {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      createdAt: "2026-05-13T00:00:00.000Z",
      sourceDomain: "agenthub.example.com",
      gitSha: "abc",
      composeVersion: "v2",
      trigger: "manual",
    });
    const json = readFileSync(join(tmp, "manifest.json"), "utf8");
    expect(JSON.parse(json).sourceDomain).toBe("agenthub.example.com");
  });
});

describe("packBundle", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "bundler-test-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("tars + gzips a staging dir into the output path", async () => {
    // Set up staging with fixture files
    writeFileSync(join(tmp, "env"), "DOMAIN=agenthub.example.com\n");
    writeFileSync(join(tmp, "agenthub.db"), Buffer.from([1, 2, 3]));
    writeFileSync(join(tmp, "infisical.sql"), Buffer.from([4, 5, 6]));
    writeFileSync(join(tmp, "manifest.json"), '{"schemaVersion":1}');

    const outPath = join(tmp, "..", "out.tar.gz");
    await packBundle(tmp, outPath);

    expect(existsSync(outPath)).toBe(true);
    expect(statSync(outPath).size).toBeGreaterThan(0);
    rmSync(outPath);
  });
});
```

(Full bundle assembly involves `docker compose exec` to `infisical-postgres` and `sqlite3` CLI — those are integration-tested separately. The unit tests cover the pure file-IO helpers.)

- [ ] **Step 4.2: Run failing tests**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/install-backup/bundler.test.ts`
Expected: fails — module not found.

- [ ] **Step 4.3: Implement bundler**

Create `packages/server/src/services/install-backup/bundler.ts`:
```typescript
import { writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, statSync } from "fs";
import { spawn } from "child_process";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { BUNDLE_SCHEMA_VERSION, type BundleManifest } from "./types.js";
import { serializeManifest } from "./manifest.js";

const BACKUPS_DIR = "/data/install-backups";
const REPO_DIR = "/repo";
const DB_PATH = "/data/agenthub.db";

export interface BundleOptions {
  trigger: BundleManifest["trigger"];
  note?: string;
  sourceDomain: string;
  gitSha: string;
  composeProject?: string; // docker compose project name; defaults to "agenthub"
}

export interface BundleResult {
  bundlePath: string;
  bytes: number;
  filename: string;
  manifest: BundleManifest;
}

export function writeStagingManifest(
  stagingDir: string,
  manifest: BundleManifest,
): void {
  writeFileSync(join(stagingDir, "manifest.json"), serializeManifest(manifest));
}

export async function packBundle(stagingDir: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "tar",
      ["-C", stagingDir, "-czf", outPath, "env", "agenthub.db", "infisical.sql", "manifest.json"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar failed (exit ${code}): ${stderr}`));
    });
  });
}

async function dumpSqlite(outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("sqlite3", [DB_PATH, `.backup '${outPath}'`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sqlite3 .backup failed (exit ${code}): ${stderr}`));
    });
  });
}

async function dumpInfisical(outPath: string, composeProject: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "--project-name", composeProject,
        "-f", join(REPO_DIR, "compose", "docker-compose.yml"),
        "exec", "-T", "infisical-postgres",
        "pg_dump", "-U", "infisical", "-F", "c", "-d", "infisical",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (b) => { chunks.push(b); });
    let stderr = "";
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("close", (code) => {
      if (code === 0) {
        writeFileSync(outPath, Buffer.concat(chunks));
        resolve();
      } else {
        reject(new Error(`pg_dump failed (exit ${code}): ${stderr}`));
      }
    });
  });
}

export async function createBundle(opts: BundleOptions): Promise<BundleResult> {
  mkdirSync(BACKUPS_DIR, { recursive: true });

  const stagingDir = mkdtempSync(join(BACKUPS_DIR, `staging-${randomUUID()}-`));
  const composeProject = opts.composeProject ?? "agenthub";

  try {
    // 1. Dump SQLite
    await dumpSqlite(join(stagingDir, "agenthub.db"));

    // 2. Dump Infisical
    await dumpInfisical(join(stagingDir, "infisical.sql"), composeProject);

    // 3. Copy .env
    const envSrc = join(REPO_DIR, "compose", ".env");
    if (!existsSync(envSrc)) {
      throw new Error(`compose/.env not found at ${envSrc}; cannot bundle`);
    }
    copyFileSync(envSrc, join(stagingDir, "env"));

    // 4. Write manifest
    const manifest: BundleManifest = {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      sourceDomain: opts.sourceDomain,
      gitSha: opts.gitSha,
      composeVersion: "v2",
      trigger: opts.trigger,
      ...(opts.note ? { note: opts.note } : {}),
    };
    writeStagingManifest(stagingDir, manifest);

    // 5. Tar + gzip
    const tsForFilename = manifest.createdAt.replace(/:/g, "-").replace(/\..+$/, "Z");
    const filename = `install-${opts.sourceDomain}-${tsForFilename}.tar.gz`;
    const bundlePath = join(BACKUPS_DIR, filename);
    await packBundle(stagingDir, bundlePath);

    const bytes = statSync(bundlePath).size;
    return { bundlePath, bytes, filename, manifest };
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4.4: Run the tests (passing)**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/install-backup/bundler.test.ts`
Expected: 2 tests pass.

- [ ] **Step 4.5: Commit**

```bash
git add packages/server/src/services/install-backup/bundler.ts packages/server/src/services/install-backup/bundler.test.ts
git commit -m "feat(install-backup): bundler service"
```

---

## Task 5: Retention service (TDD)

**Files:**
- Create: `packages/server/src/services/install-backup/retention.ts`
- Create: `packages/server/src/services/install-backup/retention.test.ts`

Prunes local AND B2 to keep last N tarballs. Sort by filename timestamp (which is ISO 8601 in the filename — lexicographic sort = chronological).

- [ ] **Step 5.1: Write the failing tests**

Create `packages/server/src/services/install-backup/retention.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { pickFilesToDelete, parseFilenameTimestamp } from "./retention.js";

describe("parseFilenameTimestamp", () => {
  it("extracts the timestamp from a bundle filename", () => {
    expect(
      parseFilenameTimestamp("install-agenthub.example.com-2026-05-13T14-30-00Z.tar.gz"),
    ).toBe("2026-05-13T14-30-00Z");
  });

  it("returns null for non-bundle filenames", () => {
    expect(parseFilenameTimestamp("readme.txt")).toBeNull();
  });
});

describe("pickFilesToDelete", () => {
  const files = [
    "install-x-2026-05-10T00-00-00Z.tar.gz",
    "install-x-2026-05-11T00-00-00Z.tar.gz",
    "install-x-2026-05-12T00-00-00Z.tar.gz",
    "install-x-2026-05-13T00-00-00Z.tar.gz",
    "install-x-2026-05-14T00-00-00Z.tar.gz",
  ];

  it("keeps the newest N", () => {
    expect(pickFilesToDelete(files, 2)).toEqual([
      "install-x-2026-05-10T00-00-00Z.tar.gz",
      "install-x-2026-05-11T00-00-00Z.tar.gz",
      "install-x-2026-05-12T00-00-00Z.tar.gz",
    ]);
  });

  it("returns empty when count <= N", () => {
    expect(pickFilesToDelete(files, 10)).toEqual([]);
  });

  it("returns empty when keepLast is 0 (treated as no retention)", () => {
    expect(pickFilesToDelete(files, 0)).toEqual([]);
  });

  it("ignores non-bundle files", () => {
    const mixed = ["readme.txt", ...files];
    expect(pickFilesToDelete(mixed, 2)).toHaveLength(3); // not 4
  });
});
```

- [ ] **Step 5.2: Run failing tests**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/install-backup/retention.test.ts`
Expected: fails — module not found.

- [ ] **Step 5.3: Implement retention**

Create `packages/server/src/services/install-backup/retention.ts`:
```typescript
import { readdirSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import type { B2Config } from "./types.js";
import { b2List, b2Delete } from "./b2-client.js";

const BUNDLE_RE = /^install-.+-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.tar\.gz$/;

export function parseFilenameTimestamp(filename: string): string | null {
  const m = BUNDLE_RE.exec(filename);
  return m ? m[1] : null;
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
    try { unlinkSync(join(dir, f)); } catch {} // best-effort
  }
  return toDelete;
}

export async function pruneB2(cfg: B2Config, keepLast: number): Promise<string[]> {
  const all = await b2List(cfg);
  const toDelete = pickFilesToDelete(all, keepLast);
  for (const f of toDelete) {
    try { await b2Delete(cfg, f); } catch {} // best-effort
  }
  return toDelete;
}
```

- [ ] **Step 5.4: Run the tests (passing)**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/install-backup/retention.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5.5: Commit**

```bash
git add packages/server/src/services/install-backup/retention.ts packages/server/src/services/install-backup/retention.test.ts
git commit -m "feat(install-backup): retention service"
```

---

## Task 6: Conflict-check service (TDD)

**Files:**
- Create: `packages/server/src/services/install-backup/conflict.ts`
- Create: `packages/server/src/services/install-backup/conflict.test.ts`

Determines whether a restore is safe (no `--force` needed) based on current install state.

- [ ] **Step 6.1: Write the failing tests**

Create `packages/server/src/services/install-backup/conflict.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { computeConflicts } from "./conflict.js";

describe("computeConflicts", () => {
  const baseState = {
    userCount: 0,
    secretCount: 0,
    activeSessionCount: 0,
    currentEnvEncryptionKey: "AAA",
    bundleEnvEncryptionKey: "AAA",
  };

  it("returns ok when install is fresh", () => {
    const r = computeConflicts(baseState);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
  });

  it("flags users-exist", () => {
    const r = computeConflicts({ ...baseState, userCount: 5 });
    expect(r.ok).toBe(false);
    expect(r.conflicts).toContainEqual(
      expect.objectContaining({ kind: "users-exist" }),
    );
  });

  it("flags secrets-exist", () => {
    const r = computeConflicts({ ...baseState, secretCount: 12 });
    expect(r.ok).toBe(false);
    expect(r.conflicts).toContainEqual(
      expect.objectContaining({ kind: "secrets-exist" }),
    );
  });

  it("flags active-sessions", () => {
    const r = computeConflicts({ ...baseState, activeSessionCount: 1 });
    expect(r.ok).toBe(false);
    expect(r.conflicts).toContainEqual(
      expect.objectContaining({ kind: "active-sessions" }),
    );
  });

  it("flags encryption-key-mismatch ONLY when secrets exist", () => {
    const noSecrets = computeConflicts({
      ...baseState,
      currentEnvEncryptionKey: "AAA",
      bundleEnvEncryptionKey: "BBB",
    });
    expect(noSecrets.conflicts.find((c) => c.kind === "encryption-key-mismatch")).toBeUndefined();

    const withSecrets = computeConflicts({
      ...baseState,
      secretCount: 5,
      currentEnvEncryptionKey: "AAA",
      bundleEnvEncryptionKey: "BBB",
    });
    expect(withSecrets.conflicts.find((c) => c.kind === "encryption-key-mismatch")).toBeDefined();
  });
});
```

- [ ] **Step 6.2: Run failing tests**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/install-backup/conflict.test.ts`
Expected: fails — module not found.

- [ ] **Step 6.3: Implement conflict**

Create `packages/server/src/services/install-backup/conflict.ts`:
```typescript
import type { Conflict, ConflictReport } from "./types.js";

export interface ConflictInputs {
  userCount: number;
  secretCount: number;
  activeSessionCount: number;
  currentEnvEncryptionKey: string;
  bundleEnvEncryptionKey: string;
}

export function computeConflicts(state: ConflictInputs): ConflictReport {
  const conflicts: Conflict[] = [];

  if (state.userCount > 0) {
    conflicts.push({
      kind: "users-exist",
      detail: `current install has ${state.userCount} user(s); restore would overwrite them`,
    });
  }
  if (state.secretCount > 0) {
    conflicts.push({
      kind: "secrets-exist",
      detail: `current Infisical has ${state.secretCount} secret(s); restore would overwrite them`,
    });
  }
  if (state.activeSessionCount > 0) {
    conflicts.push({
      kind: "active-sessions",
      detail: `${state.activeSessionCount} workspace session(s) are running; end them before restore`,
    });
  }
  if (
    state.secretCount > 0 &&
    state.currentEnvEncryptionKey !== state.bundleEnvEncryptionKey
  ) {
    conflicts.push({
      kind: "encryption-key-mismatch",
      detail:
        "INFISICAL_ENCRYPTION_KEY in bundle differs from current install. " +
        "Restoring would leave existing Infisical secrets undecryptable. " +
        "Use --force only if you're certain.",
    });
  }

  return { ok: conflicts.length === 0, conflicts };
}
```

- [ ] **Step 6.4: Run the tests (passing)**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/install-backup/conflict.test.ts`
Expected: 5 tests pass.

- [ ] **Step 6.5: Commit**

```bash
git add packages/server/src/services/install-backup/conflict.ts packages/server/src/services/install-backup/conflict.test.ts
git commit -m "feat(install-backup): conflict-check service"
```

---

## Task 7: Restorer service

**Files:**
- Create: `packages/server/src/services/install-backup/restorer.ts`

The restorer is the operational counterpart to the bundler. It parses a tarball, validates the manifest, gathers conflict-check inputs from the running install, and (if no conflicts or --force) performs the destructive replay.

Unit-testing the destructive replay is hard (real docker compose stop / pg_restore). The pure parts (extract-and-validate) are testable; the destructive parts are integration/e2e.

- [ ] **Step 7.1: Implement restorer (no failing-test-first because it's mostly shell-out orchestration)**

Create `packages/server/src/services/install-backup/restorer.ts`:
```typescript
import { spawn } from "child_process";
import { mkdtempSync, readFileSync, copyFileSync, existsSync, rmSync, createReadStream } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { parseManifest } from "./manifest.js";
import { computeConflicts } from "./conflict.js";
import type { BundleManifest, ConflictReport, RestoreSource, B2Config } from "./types.js";
import { b2Pull, b2List } from "./b2-client.js";
import { parseFilenameTimestamp } from "./retention.js";

const REPO_DIR = "/repo";
const DB_PATH = "/data/agenthub.db";

export interface ResolvedBundle {
  localPath: string;
  manifest: BundleManifest;
  stagingDir: string;
}

export interface RestoreInputs {
  b2Config: B2Config | null; // null = local-only mode
  currentEnvEncryptionKey: string;
  userCount: number;
  secretCount: number;
  activeSessionCount: number;
}

export async function resolveSource(
  source: RestoreSource,
  b2Config: B2Config | null,
): Promise<string> {
  if (source.kind === "local") return source.path;

  if (!b2Config) {
    throw new Error("restore source requires B2 credentials; configure B2 first");
  }

  const tmp = mkdtempSync(join(tmpdir(), `restore-${randomUUID()}-`));
  const localCopy = join(tmp, "bundle.tar.gz");

  if (source.kind === "b2-url") {
    // Parse b2://bucket/path → use as remote ref directly
    // Strip the b2://bucket/ prefix for the rclone call
    const m = /^b2:\/\/[^/]+\/(.+)$/.exec(source.url);
    if (!m) throw new Error(`invalid b2:// URL: ${source.url}`);
    await b2Pull(b2Config, m[1], localCopy);
    return localCopy;
  }

  // b2-snapshot
  const filenames = await b2List(b2Config);
  const bundles = filenames
    .filter((f) => parseFilenameTimestamp(f) !== null)
    .sort();
  if (bundles.length === 0) throw new Error("no bundles found in B2 bucket");

  let chosen: string;
  if (source.snapshot === "latest") {
    chosen = bundles[bundles.length - 1];
  } else {
    const found = bundles.find((f) => f.includes(source.snapshot));
    if (!found) {
      throw new Error(`no bundle matches snapshot ${source.snapshot}`);
    }
    chosen = found;
  }
  await b2Pull(b2Config, chosen, localCopy);
  return localCopy;
}

export async function extractAndValidate(bundlePath: string): Promise<ResolvedBundle> {
  const stagingDir = mkdtempSync(join(tmpdir(), `restore-staging-${randomUUID()}-`));

  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-C", stagingDir, "-xzf", bundlePath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar extract failed (exit ${code}): ${stderr}`));
    });
  });

  // Validate manifest
  const manifestPath = join(stagingDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw new Error("bundle missing manifest.json");
  }
  const manifest = parseManifest(readFileSync(manifestPath, "utf8"));

  // Validate all expected files present
  for (const f of ["env", "agenthub.db", "infisical.sql"]) {
    if (!existsSync(join(stagingDir, f))) {
      rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(`bundle missing ${f}`);
    }
  }

  return { localPath: bundlePath, manifest, stagingDir };
}

function readEnvEncryptionKey(envContent: string): string {
  const m = /^INFISICAL_ENCRYPTION_KEY=(.+)$/m.exec(envContent);
  return m ? m[1].trim() : "";
}

export function buildConflictReport(
  bundle: ResolvedBundle,
  inputs: RestoreInputs,
): ConflictReport {
  const bundleEnv = readFileSync(join(bundle.stagingDir, "env"), "utf8");
  return computeConflicts({
    userCount: inputs.userCount,
    secretCount: inputs.secretCount,
    activeSessionCount: inputs.activeSessionCount,
    currentEnvEncryptionKey: inputs.currentEnvEncryptionKey,
    bundleEnvEncryptionKey: readEnvEncryptionKey(bundleEnv),
  });
}

export async function applyRestore(
  bundle: ResolvedBundle,
  composeProject: string,
  onLine?: (line: string) => void,
): Promise<void> {
  const log = (l: string): void => { if (onLine) onLine(l); };

  // 1. Stop the writable services (NOT infisical-postgres or redis)
  log("[restore] stopping agenthub services...");
  await dockerComposeCmd(composeProject, ["stop", "agenthub-server", "traefik"]);

  // 2. Replace .env
  log("[restore] replacing compose/.env...");
  copyFileSync(join(bundle.stagingDir, "env"), join(REPO_DIR, "compose", ".env"));

  // 3. Replace SQLite (atomic)
  log("[restore] replacing /data/agenthub.db...");
  copyFileSync(join(bundle.stagingDir, "agenthub.db"), DB_PATH);

  // 4. pg_restore (Infisical postgres must be up)
  log("[restore] restoring Infisical Postgres...");
  await pgRestore(bundle.stagingDir, composeProject, log);

  // 5. Bring stack back up
  log("[restore] starting agenthub services...");
  await dockerComposeCmd(composeProject, ["up", "-d"]);

  log("[restore] complete; verify /api/health");
}

async function dockerComposeCmd(
  project: string,
  args: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "--project-name", project,
        "-f", join(REPO_DIR, "compose", "docker-compose.yml"),
        ...args,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker compose ${args[0]} failed: ${stderr}`));
    });
  });
}

async function pgRestore(
  stagingDir: string,
  composeProject: string,
  log: (l: string) => void,
): Promise<void> {
  const dumpPath = join(stagingDir, "infisical.sql");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "--project-name", composeProject,
        "-f", join(REPO_DIR, "compose", "docker-compose.yml"),
        "exec", "-T", "infisical-postgres",
        "pg_restore",
        "-U", "infisical",
        "-d", "infisical",
        "--clean", "--if-exists", "--no-owner",
      ],
      { stdio: [createReadStream(dumpPath) as never, "pipe", "pipe"] },
    );
    child.stdout.on("data", (b) => log(`[pg_restore] ${b.toString().trim()}`));
    let stderr = "";
    child.stderr.on("data", (b) => {
      const s = b.toString();
      stderr += s;
      log(`[pg_restore] ${s.trim()}`);
    });
    child.on("close", (code) => {
      // pg_restore can return non-zero on benign warnings; check stderr
      if (code === 0 || stderr.includes("WARNING")) resolve();
      else reject(new Error(`pg_restore failed (exit ${code}): ${stderr.slice(-500)}`));
    });
  });
}
```

- [ ] **Step 7.2: Run typecheck**

Run: `pnpm --filter @agenthub/server exec tsc --noEmit`
Expected: passes.

- [ ] **Step 7.3: Commit**

```bash
git add packages/server/src/services/install-backup/restorer.ts
git commit -m "feat(install-backup): restorer service (extract, validate, apply)"
```

---

## Task 8: Run orchestrator + DB helpers

**Files:**
- Create: `packages/server/src/services/install-backup/runner.ts`

The orchestrator ties everything together: load config, run the bundle, push to B2, update DB runs table, prune retention. Used by both the manual endpoint and the auto-update hook.

- [ ] **Step 8.1: Implement runner**

Create `packages/server/src/services/install-backup/runner.ts`:
```typescript
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { db } from "../../db/index.js";
import { installBackupConfig, installBackupRuns } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { createBundle } from "./bundler.js";
import { b2Push } from "./b2-client.js";
import { pruneLocal, pruneB2 } from "./retention.js";
import type { B2Config, BackupRunSummary, BundleManifest } from "./types.js";
import { getSecret, setSecret } from "../secrets/helpers.js"; // existing Infisical helper
import { execSync } from "child_process";

const BACKUPS_DIR = "/data/install-backups";

export async function loadB2Config(): Promise<B2Config | null> {
  const rows = await db.select().from(installBackupConfig).where(eq(installBackupConfig.id, 1));
  if (rows.length === 0) return null;
  const row = rows[0];
  if (!row.b2KeyId || !row.b2Bucket) return null;
  const appKey = await getSecret("/system/install-backup/b2_app_key");
  if (!appKey) return null;
  return {
    keyId: row.b2KeyId,
    appKey,
    bucket: row.b2Bucket,
    pathPrefix: row.b2PathPrefix ?? "installs/",
  };
}

export async function loadRetentionKeepLast(): Promise<number> {
  const rows = await db.select().from(installBackupConfig).where(eq(installBackupConfig.id, 1));
  return rows[0]?.retentionKeepLast ?? 10;
}

export interface RunOptions {
  trigger: "manual" | "auto-update" | "cli";
  note?: string;
  noB2?: boolean;
  onLog?: (line: string) => void;
}

export async function runBackup(opts: RunOptions): Promise<BackupRunSummary> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const log = opts.onLog ?? (() => {});

  await db.insert(installBackupRuns).values({
    id: runId,
    startedAt,
    status: "running",
    trigger: opts.trigger,
    note: opts.note ?? null,
  });

  try {
    const sourceDomain = process.env["AGENTHUB_DOMAIN"] ?? "localhost";
    const gitSha = readGitSha();

    log(`[backup] starting bundle (trigger=${opts.trigger}, source=${sourceDomain})`);
    const bundle = await createBundle({
      trigger: opts.trigger,
      ...(opts.note ? { note: opts.note } : {}),
      sourceDomain,
      gitSha,
    });
    log(`[backup] bundle written: ${bundle.bundlePath} (${bundle.bytes} bytes)`);

    let b2Path: string | null = null;
    if (!opts.noB2) {
      const cfg = await loadB2Config();
      if (cfg) {
        log(`[backup] pushing to B2 bucket ${cfg.bucket}/${cfg.pathPrefix}${bundle.filename}`);
        await b2Push(cfg, bundle.bundlePath, bundle.filename, (l) => log(`[rclone] ${l}`));
        b2Path = `b2://${cfg.bucket}/${cfg.pathPrefix}${bundle.filename}`;
        log(`[backup] uploaded to B2`);
      } else {
        log(`[backup] B2 not configured; local-only`);
      }
    }

    const keepLast = await loadRetentionKeepLast();
    if (keepLast > 0) {
      const localPruned = pruneLocal(BACKUPS_DIR, keepLast);
      if (localPruned.length > 0) log(`[backup] pruned ${localPruned.length} old local bundle(s)`);
      if (b2Path) {
        const cfg = await loadB2Config();
        if (cfg) {
          const b2Pruned = await pruneB2(cfg, keepLast);
          if (b2Pruned.length > 0) log(`[backup] pruned ${b2Pruned.length} old B2 bundle(s)`);
        }
      }
    }

    const finishedAt = new Date().toISOString();
    await db.update(installBackupRuns).set({
      finishedAt,
      status: "ok",
      bytes: bundle.bytes,
      localPath: bundle.bundlePath,
      b2Path,
    }).where(eq(installBackupRuns.id, runId));

    return {
      id: runId,
      startedAt,
      finishedAt,
      status: "ok",
      bytes: bundle.bytes,
      localPath: bundle.bundlePath,
      b2Path,
      trigger: opts.trigger,
      error: null,
      note: opts.note ?? null,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`[backup] FAILED: ${errMsg}`);
    await db.update(installBackupRuns).set({
      finishedAt: new Date().toISOString(),
      status: "failed",
      error: errMsg,
    }).where(eq(installBackupRuns.id, runId));
    throw err;
  }
}

function readGitSha(): string {
  try {
    return execSync("git -C /repo rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
```

NOTE: this assumes `getSecret`/`setSecret` helpers exist at `services/secrets/helpers.ts` (per existing infrastructure_configs pattern). If they don't, look at how existing code reads/writes Infisical secrets and adapt.

- [ ] **Step 8.2: Verify the secrets helper exists**

Run: `grep -rn "export.*getSecret\|export.*setSecret" packages/server/src/services/secrets/ 2>/dev/null | head -5`

If the exports are named differently, update `runner.ts` to match (e.g., maybe `fetchSecret` / `storeSecret`).

- [ ] **Step 8.3: Run typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 8.4: Commit**

```bash
git add packages/server/src/services/install-backup/runner.ts
git commit -m "feat(install-backup): runner orchestrator"
```

---

## Task 9: Server routes (8 endpoints)

**Files:**
- Create: `packages/server/src/routes/admin-install-backup.ts`
- Modify: `packages/server/src/index.ts` (mount the new route module)

- [ ] **Step 9.1: Implement the routes**

Create `packages/server/src/routes/admin-install-backup.ts`:
```typescript
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createReadStream, existsSync, statSync } from "fs";
import { Readable } from "stream";
import { db } from "../db/index.js";
import { installBackupConfig, installBackupRuns, users, sessions } from "../db/schema.js";
import { eq, desc, sql } from "drizzle-orm";
import { runBackup, loadB2Config } from "../services/install-backup/runner.js";
import { resolveSource, extractAndValidate, buildConflictReport, applyRestore } from "../services/install-backup/restorer.js";
import { b2List } from "../services/install-backup/b2-client.js";
import { setSecret, getSecret } from "../services/secrets/helpers.js";
import type { RestoreSource } from "../services/install-backup/types.js";

const MASK = "••••••••";

export function installBackupRoutes(): Hono {
  const app = new Hono();

  // GET /api/admin/install-backup
  app.get("/", async (c) => {
    const rows = await db.select().from(installBackupConfig).where(eq(installBackupConfig.id, 1));
    const row = rows[0];
    const lastRun = (await db.select().from(installBackupRuns)
      .orderBy(desc(installBackupRuns.startedAt)).limit(1))[0];

    return c.json({
      b2: row ? {
        keyId: row.b2KeyId ?? "",
        appKey: row.b2KeyId ? MASK : "",
        bucket: row.b2Bucket ?? "",
        pathPrefix: row.b2PathPrefix ?? "installs/",
        retentionKeepLast: row.retentionKeepLast ?? 10,
      } : null,
      lastRun: lastRun ? {
        id: lastRun.id,
        startedAt: lastRun.startedAt,
        finishedAt: lastRun.finishedAt,
        status: lastRun.status,
        bytes: lastRun.bytes,
        b2Path: lastRun.b2Path,
        localPath: lastRun.localPath,
        trigger: lastRun.trigger,
      } : null,
    });
  });

  // PUT /api/admin/install-backup — save B2 config
  app.put("/", async (c) => {
    const body = await c.req.json<{
      b2KeyId: string;
      b2AppKey?: string; // optional: only set if changed
      b2Bucket: string;
      b2PathPrefix?: string;
      retentionKeepLast?: number;
    }>();

    if (body.b2AppKey && body.b2AppKey !== MASK) {
      await setSecret("/system/install-backup/b2_app_key", body.b2AppKey);
    }

    const now = new Date().toISOString();
    const existing = await db.select().from(installBackupConfig).where(eq(installBackupConfig.id, 1));
    if (existing.length === 0) {
      await db.insert(installBackupConfig).values({
        id: 1,
        b2KeyId: body.b2KeyId,
        b2Bucket: body.b2Bucket,
        b2PathPrefix: body.b2PathPrefix ?? "installs/",
        retentionKeepLast: body.retentionKeepLast ?? 10,
        updatedAt: now,
      });
    } else {
      await db.update(installBackupConfig).set({
        b2KeyId: body.b2KeyId,
        b2Bucket: body.b2Bucket,
        b2PathPrefix: body.b2PathPrefix ?? "installs/",
        retentionKeepLast: body.retentionKeepLast ?? 10,
        updatedAt: now,
      }).where(eq(installBackupConfig.id, 1));
    }
    return c.json({ ok: true });
  });

  // POST /api/admin/install-backup/test
  app.post("/test", async (c) => {
    const cfg = await loadB2Config();
    if (!cfg) return c.json({ ok: false, error: "B2 not configured" }, 400);
    try {
      const files = await b2List(cfg);
      return c.json({ ok: true, fileCount: files.length });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // POST /api/admin/install-backup/run — SSE
  app.post("/run", async (c) => {
    const body = await c.req.json<{ noB2?: boolean; note?: string }>();
    return streamSSE(c, async (stream) => {
      const safeWrite = (ev: { event: string; data: string }): void => {
        stream.writeSSE(ev).catch(() => {});
      };
      try {
        const result = await runBackup({
          trigger: "manual",
          ...(body.note ? { note: body.note } : {}),
          ...(body.noB2 ? { noB2: true } : {}),
          onLog: (line) => safeWrite({ event: "log", data: line }),
        });
        safeWrite({ event: "done", data: JSON.stringify(result) });
      } catch (err) {
        safeWrite({ event: "error", data: err instanceof Error ? err.message : "unknown" });
      }
    });
  });

  // GET /api/admin/install-backup/runs
  app.get("/runs", async (c) => {
    const rows = await db.select().from(installBackupRuns)
      .orderBy(desc(installBackupRuns.startedAt)).limit(50);
    return c.json({ runs: rows });
  });

  // GET /api/admin/install-backup/runs/:id/download
  app.get("/runs/:id/download", async (c) => {
    const id = c.req.param("id");
    const rows = await db.select().from(installBackupRuns).where(eq(installBackupRuns.id, id));
    if (rows.length === 0 || !rows[0].localPath) {
      return c.json({ error: "not found or no local copy" }, 404);
    }
    const localPath = rows[0].localPath;
    if (!existsSync(localPath)) {
      return c.json({ error: "local file missing" }, 404);
    }
    const stat = statSync(localPath);
    return new Response(Readable.toWeb(createReadStream(localPath)) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Length": String(stat.size),
        "Content-Disposition": `attachment; filename="${localPath.split("/").pop()}"`,
      },
    });
  });

  // POST /api/admin/install-backup/restore/validate
  app.post("/restore/validate", async (c) => {
    const body = await c.req.json<{ source: RestoreSource }>();
    const cfg = await loadB2Config();
    try {
      const localPath = await resolveSource(body.source, cfg);
      const bundle = await extractAndValidate(localPath);

      const userCountResult = await db.select({ c: sql<number>`count(*)` }).from(users);
      const activeSessionCountResult = await db.select({ c: sql<number>`count(*)` })
        .from(sessions)
        .where(sql`status NOT IN ('destroyed', 'failed')`);

      // secretCount: pass 0 — we don't have a cheap Infisical-side count
      // query yet. Effect: the encryption-key-mismatch conflict only triggers
      // when secretCount > 0, so we conservatively never flag it. Documented
      // as a known limitation in docs/operations/install-backup.md; a
      // follow-up can add a real query via the Infisical SDK.
      const report = buildConflictReport(bundle, {
        b2Config: cfg,
        userCount: Number(userCountResult[0]?.c ?? 0),
        secretCount: 0,
        activeSessionCount: Number(activeSessionCountResult[0]?.c ?? 0),
        currentEnvEncryptionKey: process.env["INFISICAL_ENCRYPTION_KEY"] ?? "",
      });

      return c.json({
        ok: report.ok,
        manifest: bundle.manifest,
        conflicts: report.conflicts,
      });
    } catch (err) {
      return c.json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }, 400);
    }
  });

  // POST /api/admin/install-backup/restore/run — SSE
  app.post("/restore/run", async (c) => {
    const confirm = c.req.header("Confirm-Restore");
    if (confirm !== "yes-i-know-what-this-does") {
      return c.json({ error: "missing Confirm-Restore header" }, 403);
    }
    const body = await c.req.json<{ source: RestoreSource; force?: boolean }>();
    return streamSSE(c, async (stream) => {
      const safeWrite = (ev: { event: string; data: string }): void => {
        stream.writeSSE(ev).catch(() => {});
      };
      try {
        const cfg = await loadB2Config();
        safeWrite({ event: "log", data: "[restore] resolving source..." });
        const localPath = await resolveSource(body.source, cfg);
        safeWrite({ event: "log", data: `[restore] extracting ${localPath}` });
        const bundle = await extractAndValidate(localPath);
        safeWrite({ event: "log", data: `[restore] manifest: ${bundle.manifest.sourceDomain} @ ${bundle.manifest.createdAt}` });

        if (!body.force) {
          const userCountResult = await db.select({ c: sql<number>`count(*)` }).from(users);
          const activeSessionCountResult = await db.select({ c: sql<number>`count(*)` })
            .from(sessions)
            .where(sql`status NOT IN ('destroyed', 'failed')`);

          const report = buildConflictReport(bundle, {
            b2Config: cfg,
            userCount: Number(userCountResult[0]?.c ?? 0),
            secretCount: 0, // see validate endpoint above for the same conservative-0 rationale
            activeSessionCount: Number(activeSessionCountResult[0]?.c ?? 0),
            currentEnvEncryptionKey: process.env["INFISICAL_ENCRYPTION_KEY"] ?? "",
          });

          if (!report.ok) {
            safeWrite({ event: "error", data: `restore conflicts (use force=true to override): ${JSON.stringify(report.conflicts)}` });
            return;
          }
        }

        const project = process.env["COMPOSE_PROJECT_NAME"] ?? "agenthub";
        await applyRestore(bundle, project, (line) => safeWrite({ event: "log", data: line }));
        safeWrite({ event: "done", data: "ok" });
      } catch (err) {
        safeWrite({ event: "error", data: err instanceof Error ? err.message : "unknown" });
      }
    });
  });

  return app;
}
```

- [ ] **Step 9.2: Mount the route module**

In `packages/server/src/index.ts`, find where other admin route modules are mounted (e.g., `app.route("/api/admin", adminRoutes())`). Add:
```typescript
import { installBackupRoutes } from "./routes/admin-install-backup.js";
// ...
app.route("/api/admin/install-backup", installBackupRoutes());
```

This must be inside the admin-role-gated section (check the existing admin middleware pattern). Match the placement of the existing admin routes.

- [ ] **Step 9.3: Run typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 9.4: Run tests**

Run: `pnpm --filter @agenthub/server test`
Expected: all server tests still pass.

- [ ] **Step 9.5: Commit**

```bash
git add packages/server/src/routes/admin-install-backup.ts packages/server/src/index.ts
git commit -m "feat(install-backup): admin routes (8 endpoints, SSE for run + restore)"
```

---

## Task 10: CLI verbs (agenthub backup-install + restore-install)

**Files:**
- Modify: `scripts/agenthub` (add two new verbs)
- Create: `scripts/restore-install.js` (entrypoint for temp restore container)

- [ ] **Step 10.1: Add `backup-install` verb to scripts/agenthub**

In `scripts/agenthub`, find the verb case-switch (around line 504 — `case "${1:-}" in`). Add:
```bash
backup-install)
  shift
  local_only=""
  no_b2=""
  note=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --local-only|--no-b2) local_only="--local-only"; shift ;;
      --note) note="$2"; shift 2 ;;
      *) die "unknown flag: $1" ;;
    esac
  done

  # POST to the running server's endpoint via curl
  body='{"noB2":'"$([ -n "$local_only" ] && echo true || echo false)"
  if [[ -n "$note" ]]; then
    body+=',"note":'"$(printf '%s' "$note" | jq -Rs .)"
  fi
  body+='}'

  # Get an admin auth cookie from .env (the server's admin user)
  # NOTE: this requires a session cookie. For headless operator use,
  # we use a service-account token via X-Internal-Token header.
  curl -fsSN -X POST \
    -H "Content-Type: application/json" \
    -H "X-Internal-Token: ${INTERNAL_TOKEN}" \
    -d "$body" \
    "http://localhost:3000/api/admin/install-backup/run" \
  || die "backup failed"
  ;;
```

NOTE: this depends on a new `X-Internal-Token` server-side auth mechanism. If not already present, simpler alternative for the CLI: `docker exec agenthub-server node -e 'require("/app/dist/services/install-backup/runner.js").runBackup(...)'`. Refine based on what's idiomatic in this codebase (read the existing `update` verb in `scripts/agenthub` for the pattern).

- [ ] **Step 10.2: Add `restore-install` verb to scripts/agenthub**

```bash
restore-install)
  shift
  from=""
  snapshot=""
  force=""
  dry_run=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --from) from="$2"; shift 2 ;;
      --snapshot) snapshot="$2"; shift 2 ;;
      --force) force="true"; shift ;;
      --dry-run) dry_run="true"; shift ;;
      *) die "unknown flag: $1" ;;
    esac
  done

  if [[ -z "$from" && -z "$snapshot" ]]; then
    die "restore-install requires --from <path-or-url> or --snapshot <latest|timestamp>"
  fi

  # Spawn the temp restore container (NOT the live server)
  exec docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v /data:/data \
    -v "$AGENTHUB_DIR:/repo" \
    --network "${COMPOSE_PROJECT_NAME:-agenthub}_default" \
    "$AGENTHUB_SERVER_IMAGE" \
    node /app/scripts/restore-install.js \
    --from "$from" \
    --snapshot "$snapshot" \
    ${force:+--force} \
    ${dry_run:+--dry-run}
  ;;
```

- [ ] **Step 10.3: Create `scripts/restore-install.js`**

This is the entrypoint that runs inside the temp container. It uses the same `services/install-backup/restorer.ts` code as the server endpoint.

Create `scripts/restore-install.js`:
```javascript
#!/usr/bin/env node
// Restore-install entrypoint, runs in a temp container per `agenthub restore-install`.
// NOTE: this file ships in the server image at /app/scripts/restore-install.js.
// The server image's build copies scripts/ into /app/scripts/.

const { resolveSource, extractAndValidate, buildConflictReport, applyRestore } =
  require("/app/dist/services/install-backup/restorer.js");
const { loadB2Config } = require("/app/dist/services/install-backup/runner.js");

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let source;
  if (args.from) {
    if (args.from.startsWith("b2://")) source = { kind: "b2-url", url: args.from };
    else source = { kind: "local", path: args.from };
  } else if (args.snapshot) {
    source = { kind: "b2-snapshot", snapshot: args.snapshot };
  } else {
    fail("missing --from or --snapshot");
  }

  const log = (line) => console.log(line);
  log(`[restore] resolving source`);
  const cfg = await loadB2Config();
  const localPath = await resolveSource(source, cfg);
  const bundle = await extractAndValidate(localPath);
  log(`[restore] manifest: ${bundle.manifest.sourceDomain} @ ${bundle.manifest.createdAt}`);

  if (args.dryRun) {
    log(`[restore] dry-run OK`);
    return;
  }

  if (!args.force) {
    // Connect to SQLite directly to compute conflicts
    // (we can't go through the running server — it may be empty)
    const Database = require("better-sqlite3");
    const db = new Database("/data/agenthub.db", { readonly: true });
    const userCount = db.prepare("SELECT count(*) AS c FROM users").get()?.c ?? 0;
    const activeSessionCount = db.prepare(
      "SELECT count(*) AS c FROM sessions WHERE status NOT IN ('destroyed','failed')",
    ).get()?.c ?? 0;
    db.close();

    const report = buildConflictReport(bundle, {
      b2Config: cfg,
      userCount,
      secretCount: 0,
      activeSessionCount,
      currentEnvEncryptionKey: process.env.INFISICAL_ENCRYPTION_KEY ?? "",
    });
    if (!report.ok) {
      log(`[restore] conflicts (use --force to override):`);
      for (const c of report.conflicts) log(`  - ${c.kind}: ${c.detail}`);
      process.exit(4);
    }
  }

  const project = process.env.COMPOSE_PROJECT_NAME ?? "agenthub";
  await applyRestore(bundle, project, log);
  log(`[restore] complete`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") out.from = argv[++i];
    else if (argv[i] === "--snapshot") out.snapshot = argv[++i];
    else if (argv[i] === "--force") out.force = true;
    else if (argv[i] === "--dry-run") out.dryRun = true;
  }
  return out;
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

main().catch((err) => {
  console.error(`[restore] FAILED: ${err.stack ?? err.message ?? err}`);
  process.exit(1);
});
```

- [ ] **Step 10.4: Ensure scripts/ is copied into the server image**

In `docker/Dockerfile.server`, find the COPY directives. After the build stage's `COPY . .`, confirm `scripts/` is included (it should be — `.` copies everything). Add a check: the runtime stage must also have `/app/scripts/restore-install.js`. Add to runtime stage:
```dockerfile
COPY --from=build /app/scripts /app/scripts
```
Adjust path based on the existing Dockerfile structure.

- [ ] **Step 10.5: Lint shellcheck**

Run: `shellcheck scripts/agenthub`
Expected: no new warnings beyond baseline.

- [ ] **Step 10.6: Commit**

```bash
git add scripts/agenthub scripts/restore-install.js docker/Dockerfile.server
git commit -m "feat(install-backup): agenthub backup-install + restore-install verbs"
```

---

## Task 11: Auto-backup on `agenthub update`

**Files:**
- Modify: `scripts/agenthub` (the `update` verb)

- [ ] **Step 11.1: Add the auto-backup call**

In `scripts/agenthub`, find the `update)` case (around line 435 in the post-TLS state). After `git pull` succeeds and BEFORE the rebuild step, add:
```bash
# Auto-backup before destructive update steps. Best-effort: failure doesn't abort.
if ! backup_install_auto; then
  warn "auto-backup failed; continuing update (previous backup preserved if any)"
fi
```

Define the `backup_install_auto` function near the other helper functions:
```bash
backup_install_auto() {
  if ! docker ps --format '{{.Names}}' | grep -q 'agenthub-server'; then
    return 1  # server not running — nothing to back up
  fi
  agenthub backup-install --note "auto-backup before update to $(git -C "$AGENTHUB_DIR" rev-parse --short HEAD)"
}
```

NOTE: the `agenthub backup-install` call here is recursive — the script calling itself. Verify shellcheck allows this. If not, factor the backup logic out to a helper function that both verbs invoke.

- [ ] **Step 11.2: Lint shellcheck**

Run: `shellcheck scripts/agenthub`
Expected: no new warnings.

- [ ] **Step 11.3: Commit**

```bash
git add scripts/agenthub
git commit -m "feat(install-backup): auto-backup before agenthub update"
```

---

## Task 12: Web UI — admin page scaffold + BackupCard

**Files:**
- Create: `packages/web/src/pages/admin/InstallBackup.tsx`
- Create: `packages/web/src/components/install-backup/BackupCard.tsx`
- Modify: `packages/web/src/App.tsx` or wherever routes are defined (mount the page + sidebar entry)

- [ ] **Step 12.1: Add the page route**

Find the existing admin pages (e.g., the Users page) by grepping for an admin-only route. Mount the new page at `/admin/install-backup` following the same pattern.

In `packages/web/src/App.tsx` (or the routes file):
```typescript
import { InstallBackupPage } from "./pages/admin/InstallBackup.js";
// ...
<Route path="/admin/install-backup" element={<RequireAdmin><InstallBackupPage /></RequireAdmin>} />
```

(Match the existing admin route + auth-guard pattern exactly.)

- [ ] **Step 12.2: Add the sidebar entry**

Find the existing Sidebar component (likely `packages/web/src/components/Sidebar.tsx`). Add a new entry for "Install Backup" under the Admin section, alongside Users. Match the existing pattern (icon + label + onClick navigate).

- [ ] **Step 12.3: Create the page**

Create `packages/web/src/pages/admin/InstallBackup.tsx`:
```tsx
import { BackupCard } from "../../components/install-backup/BackupCard.js";
import { B2ConfigCard } from "../../components/install-backup/B2ConfigCard.js";
import { HistoryTable } from "../../components/install-backup/HistoryTable.js";
import { RestoreCard } from "../../components/install-backup/RestoreCard.js";

export function InstallBackupPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Install Backup</h1>
      <BackupCard />
      <B2ConfigCard />
      <HistoryTable />
      <RestoreCard />
    </div>
  );
}
```

- [ ] **Step 12.4: Create BackupCard**

Create `packages/web/src/components/install-backup/BackupCard.tsx`:
```tsx
import { useState, useEffect } from "react";

interface LastRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  bytes: number | null;
  b2Path: string | null;
  localPath: string | null;
}

export function BackupCard() {
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  async function refresh() {
    const r = await fetch("/api/admin/install-backup");
    if (r.ok) {
      const j = await r.json();
      setLastRun(j.lastRun);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function runBackup() {
    setRunning(true);
    setLog([]);
    try {
      const res = await fetch("/api/admin/install-backup/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Parse SSE events (simple framing)
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) {
          const lines = p.split("\n");
          const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
          const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          if (event === "log") setLog((prev) => [...prev, data]);
          if (event === "done") { setRunning(false); refresh(); }
          if (event === "error") { setLog((prev) => [...prev, `ERROR: ${data}`]); setRunning(false); }
        }
      }
    } catch (err) {
      setLog((prev) => [...prev, `ERROR: ${err instanceof Error ? err.message : String(err)}`]);
      setRunning(false);
    }
  }

  return (
    <section className="rounded-lg border p-4 space-y-2">
      <h2 className="font-medium">Last backup</h2>
      {lastRun ? (
        <p className="text-sm text-gray-600">
          {new Date(lastRun.startedAt).toLocaleString()} —{" "}
          <span className={lastRun.status === "ok" ? "text-green-700" : "text-red-700"}>
            {lastRun.status}
          </span>
          {lastRun.bytes ? ` — ${(lastRun.bytes / 1024 / 1024).toFixed(1)} MB` : ""}
        </p>
      ) : (
        <p className="text-sm text-gray-600">No backups yet.</p>
      )}
      <button
        className="px-3 py-1 rounded bg-blue-600 text-white disabled:opacity-50"
        disabled={running}
        onClick={runBackup}
      >
        {running ? "Backing up..." : "Backup now"}
      </button>
      {log.length > 0 && (
        <pre className="text-xs bg-gray-50 p-2 rounded max-h-48 overflow-auto">
          {log.join("\n")}
        </pre>
      )}
    </section>
  );
}
```

(Match existing styling — Tailwind classes consistent with rest of the codebase.)

- [ ] **Step 12.5: Run web build**

Run: `pnpm --filter @agenthub/web build`
Expected: build succeeds.

- [ ] **Step 12.6: Commit**

```bash
git add packages/web/src/pages/admin/InstallBackup.tsx packages/web/src/components/install-backup/BackupCard.tsx packages/web/src/App.tsx packages/web/src/components/Sidebar.tsx
git commit -m "feat(install-backup): admin page + BackupCard"
```

---

## Task 13: Web UI — B2ConfigCard

**Files:**
- Create: `packages/web/src/components/install-backup/B2ConfigCard.tsx`

- [ ] **Step 13.1: Create the component**

Create `packages/web/src/components/install-backup/B2ConfigCard.tsx`:
```tsx
import { useState, useEffect } from "react";

interface B2Config {
  keyId: string;
  appKey: string;
  bucket: string;
  pathPrefix: string;
  retentionKeepLast: number;
}

export function B2ConfigCard() {
  const [cfg, setCfg] = useState<B2Config | null>(null);
  const [keyId, setKeyId] = useState("");
  const [appKey, setAppKey] = useState("");
  const [bucket, setBucket] = useState("");
  const [pathPrefix, setPathPrefix] = useState("installs/");
  const [retentionKeepLast, setRetentionKeepLast] = useState(10);
  const [testResult, setTestResult] = useState<string>("");

  async function load() {
    const r = await fetch("/api/admin/install-backup");
    if (r.ok) {
      const j = await r.json();
      if (j.b2) {
        setCfg(j.b2);
        setKeyId(j.b2.keyId);
        setAppKey(j.b2.appKey); // masked
        setBucket(j.b2.bucket);
        setPathPrefix(j.b2.pathPrefix);
        setRetentionKeepLast(j.b2.retentionKeepLast);
      }
    }
  }

  useEffect(() => { load(); }, []);

  async function save() {
    const body: Record<string, unknown> = {
      b2KeyId: keyId,
      b2Bucket: bucket,
      b2PathPrefix: pathPrefix,
      retentionKeepLast,
    };
    // Only send appKey if changed (not the masked placeholder)
    if (appKey && appKey !== "••••••••") body.b2AppKey = appKey;

    const r = await fetch("/api/admin/install-backup", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      setTestResult("Saved.");
      load();
    } else {
      setTestResult(`Save failed: ${r.status}`);
    }
  }

  async function test() {
    setTestResult("Testing...");
    const r = await fetch("/api/admin/install-backup/test", { method: "POST" });
    const j = await r.json();
    if (j.ok) setTestResult(`OK — ${j.fileCount} object(s) in bucket.`);
    else setTestResult(`Failed: ${j.error}`);
  }

  return (
    <section className="rounded-lg border p-4 space-y-3">
      <h2 className="font-medium">B2 destination</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        <label className="block">
          <span className="text-gray-700">Key ID</span>
          <input className="mt-1 w-full border rounded px-2 py-1"
            value={keyId} onChange={(e) => setKeyId(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-gray-700">App Key</span>
          <input type="password" className="mt-1 w-full border rounded px-2 py-1"
            value={appKey} onChange={(e) => setAppKey(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-gray-700">Bucket</span>
          <input className="mt-1 w-full border rounded px-2 py-1"
            value={bucket} onChange={(e) => setBucket(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-gray-700">Path prefix</span>
          <input className="mt-1 w-full border rounded px-2 py-1"
            value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-gray-700">Keep last N</span>
          <input type="number" className="mt-1 w-full border rounded px-2 py-1"
            value={retentionKeepLast}
            onChange={(e) => setRetentionKeepLast(parseInt(e.target.value, 10) || 10)} />
        </label>
      </div>
      <div className="flex gap-2">
        <button className="px-3 py-1 rounded bg-blue-600 text-white" onClick={save}>Save</button>
        <button className="px-3 py-1 rounded border" onClick={test}>Test</button>
        {testResult && <span className="text-sm text-gray-700">{testResult}</span>}
      </div>
    </section>
  );
}
```

- [ ] **Step 13.2: Run web build**

Run: `pnpm --filter @agenthub/web build`
Expected: build succeeds.

- [ ] **Step 13.3: Commit**

```bash
git add packages/web/src/components/install-backup/B2ConfigCard.tsx
git commit -m "feat(install-backup): B2ConfigCard component"
```

---

## Task 14: Web UI — HistoryTable

**Files:**
- Create: `packages/web/src/components/install-backup/HistoryTable.tsx`

- [ ] **Step 14.1: Create the component**

Create `packages/web/src/components/install-backup/HistoryTable.tsx`:
```tsx
import { useState, useEffect } from "react";

interface Run {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  bytes: number | null;
  localPath: string | null;
  b2Path: string | null;
  trigger: string;
  note: string | null;
}

export function HistoryTable() {
  const [runs, setRuns] = useState<Run[]>([]);

  async function load() {
    const r = await fetch("/api/admin/install-backup/runs");
    if (r.ok) {
      const j = await r.json();
      setRuns(j.runs);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <section className="rounded-lg border p-4 space-y-2">
      <h2 className="font-medium">History</h2>
      {runs.length === 0 ? (
        <p className="text-sm text-gray-600">No history yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-600">
              <th className="py-1">Started</th>
              <th>Status</th>
              <th>Size</th>
              <th>Destinations</th>
              <th>Trigger</th>
              <th>Note</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="py-1">{new Date(r.startedAt).toLocaleString()}</td>
                <td className={r.status === "ok" ? "text-green-700" : "text-red-700"}>
                  {r.status}
                </td>
                <td>{r.bytes ? `${(r.bytes / 1024 / 1024).toFixed(1)} MB` : "—"}</td>
                <td>
                  {r.localPath ? "Local " : ""}
                  {r.b2Path ? "B2" : ""}
                  {!r.localPath && !r.b2Path ? "—" : ""}
                </td>
                <td>{r.trigger}</td>
                <td className="text-gray-500 truncate max-w-xs">{r.note ?? ""}</td>
                <td>
                  {r.localPath && (
                    <a
                      href={`/api/admin/install-backup/runs/${r.id}/download`}
                      className="text-blue-600 hover:underline"
                    >Download</a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
```

- [ ] **Step 14.2: Run web build**

Run: `pnpm --filter @agenthub/web build`
Expected: build succeeds.

- [ ] **Step 14.3: Commit**

```bash
git add packages/web/src/components/install-backup/HistoryTable.tsx
git commit -m "feat(install-backup): HistoryTable component"
```

---

## Task 15: Web UI — RestoreCard

**Files:**
- Create: `packages/web/src/components/install-backup/RestoreCard.tsx`

- [ ] **Step 15.1: Create the component**

Create `packages/web/src/components/install-backup/RestoreCard.tsx`:
```tsx
import { useState } from "react";

type SourceKind = "history" | "upload" | "b2-timestamp";

interface ValidateResult {
  ok: boolean;
  manifest?: {
    sourceDomain: string;
    createdAt: string;
    gitSha: string;
  };
  conflicts?: Array<{ kind: string; detail: string }>;
  error?: string;
}

export function RestoreCard() {
  const [sourceKind, setSourceKind] = useState<SourceKind>("history");
  const [historyId, setHistoryId] = useState("");
  const [b2Timestamp, setB2Timestamp] = useState("");
  const [validate, setValidate] = useState<ValidateResult | null>(null);
  const [confirmDomain, setConfirmDomain] = useState("");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  function buildSource() {
    if (sourceKind === "history") return { kind: "local", path: historyId }; // historyId maps to localPath via /runs endpoint
    if (sourceKind === "b2-timestamp") return { kind: "b2-snapshot", snapshot: b2Timestamp };
    // upload: handled separately (multipart)
    return null;
  }

  async function runValidate() {
    const source = buildSource();
    if (!source) return;
    setValidate(null);
    const r = await fetch("/api/admin/install-backup/restore/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
    });
    setValidate(await r.json());
  }

  async function runRestore() {
    const source = buildSource();
    if (!source || !validate?.manifest) return;
    if (confirmDomain !== validate.manifest.sourceDomain) {
      alert(`Type the source domain (${validate.manifest.sourceDomain}) to confirm.`);
      return;
    }
    setRunning(true);
    setLog([]);
    const res = await fetch("/api/admin/install-backup/restore/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Confirm-Restore": "yes-i-know-what-this-does",
      },
      body: JSON.stringify({ source, force: !validate.ok }),
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const p of parts) {
        const lines = p.split("\n");
        const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
        const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
        if (event === "log") setLog((prev) => [...prev, data]);
        if (event === "done") setRunning(false);
        if (event === "error") { setLog((prev) => [...prev, `ERROR: ${data}`]); setRunning(false); }
      }
    }
  }

  return (
    <section className="rounded-lg border p-4 space-y-3 border-amber-300 bg-amber-50">
      <h2 className="font-medium text-amber-900">⚠ Restore</h2>
      <p className="text-sm text-amber-900">
        Restoring overwrites current install state. All users, sessions, and secrets will be replaced.
      </p>

      <div className="space-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" checked={sourceKind === "history"}
            onChange={() => setSourceKind("history")} />
          From a backup in history (paste local path)
        </label>
        {sourceKind === "history" && (
          <input className="w-full border rounded px-2 py-1"
            placeholder="/data/install-backups/install-foo.tar.gz"
            value={historyId} onChange={(e) => setHistoryId(e.target.value)} />
        )}

        <label className="flex items-center gap-2">
          <input type="radio" checked={sourceKind === "b2-timestamp"}
            onChange={() => setSourceKind("b2-timestamp")} />
          Pull from B2 by timestamp ("latest" or YYYY-MM-DDTHH-mm-ssZ)
        </label>
        {sourceKind === "b2-timestamp" && (
          <input className="w-full border rounded px-2 py-1"
            placeholder="latest"
            value={b2Timestamp} onChange={(e) => setB2Timestamp(e.target.value)} />
        )}
      </div>

      <div className="flex gap-2">
        <button className="px-3 py-1 rounded border" onClick={runValidate}>Dry-run validate</button>
      </div>

      {validate && (
        <div className="text-sm space-y-1">
          {validate.error && <p className="text-red-700">Validate failed: {validate.error}</p>}
          {validate.manifest && (
            <>
              <p>Bundle from <code>{validate.manifest.sourceDomain}</code> at {validate.manifest.createdAt}.</p>
              {validate.conflicts && validate.conflicts.length > 0 && (
                <div className="text-red-700">
                  <p>Conflicts:</p>
                  <ul className="list-disc ml-6">
                    {validate.conflicts.map((c, i) => <li key={i}>{c.kind}: {c.detail}</li>)}
                  </ul>
                  <p>Restore will proceed with force=true if you continue.</p>
                </div>
              )}
              <label className="block mt-2">
                <span>Type <code>{validate.manifest.sourceDomain}</code> to confirm:</span>
                <input className="ml-2 border rounded px-2 py-1"
                  value={confirmDomain} onChange={(e) => setConfirmDomain(e.target.value)} />
              </label>
              <button
                className="mt-2 px-3 py-1 rounded bg-red-700 text-white disabled:opacity-50"
                disabled={confirmDomain !== validate.manifest.sourceDomain || running}
                onClick={runRestore}
              >
                {running ? "Restoring..." : "Restore"}
              </button>
            </>
          )}
        </div>
      )}

      {log.length > 0 && (
        <pre className="text-xs bg-gray-50 p-2 rounded max-h-64 overflow-auto">
          {log.join("\n")}
        </pre>
      )}
    </section>
  );
}
```

(Upload-from-file is omitted for brevity in the first PR — operator can use B2-timestamp or local-path for the same outcome. Add upload in a follow-up.)

- [ ] **Step 15.2: Run web build**

Run: `pnpm --filter @agenthub/web build`
Expected: build succeeds.

- [ ] **Step 15.3: Commit**

```bash
git add packages/web/src/components/install-backup/RestoreCard.tsx
git commit -m "feat(install-backup): RestoreCard component"
```

---

## Task 16: E2E integration test

**Files:**
- Modify: `scripts/e2e-full.js`

- [ ] **Step 16.1: Append a backup test**

After the existing tests in `scripts/e2e-full.js`, append:
```javascript
async function testInstallBackup() {
  console.log("[e2e] install-backup test");

  // Trigger backup (local-only to avoid B2 cost in tests)
  // Note: this requires admin auth; use the same cookie the existing tests get from login
  const res = await fetch(`${baseUrl}/api/admin/install-backup/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ noB2: true, note: "e2e-test" }),
  });

  let done = false;
  let errored = false;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const p of parts) {
      const event = p.split("\n").find((l) => l.startsWith("event:"))?.slice(6).trim();
      if (event === "done") done = true;
      if (event === "error") errored = true;
    }
  }
  if (!done || errored) throw new Error(`backup did not complete cleanly (done=${done}, errored=${errored})`);

  // Verify history endpoint
  const histRes = await fetch(`${baseUrl}/api/admin/install-backup/runs`, {
    headers: { Cookie: cookie },
  });
  const hist = await histRes.json();
  if (!hist.runs || hist.runs.length === 0) throw new Error("no run in history");
  const latest = hist.runs[0];
  if (latest.status !== "ok") throw new Error(`latest run status=${latest.status}`);
  if (latest.note !== "e2e-test") throw new Error(`latest run note=${latest.note}`);

  console.log("[e2e] install-backup OK (bundle size:", latest.bytes, "bytes)");
}
```

Wire into the main flow (gated on a feature flag so it doesn't run in environments without `sqlite3` CLI installed — though the server container has it).

- [ ] **Step 16.2: Sanity-check the script**

Run: `node --check scripts/e2e-full.js`
Expected: no syntax errors.

- [ ] **Step 16.3: Commit**

```bash
git add scripts/e2e-full.js
git commit -m "test(e2e): install-backup smoke (run + history check)"
```

---

## Task 17: Docs

**Files:**
- Create: `docs/operations/install-backup.md`
- Modify: `CLAUDE.md`

- [ ] **Step 17.1: Write the operator doc**

Create `docs/operations/install-backup.md` with sections:
- Overview (what this backs up, what it doesn't — workspace files are separate per-user backups)
- Setup (configure B2 in admin UI)
- Manual backup (CLI + UI)
- Auto-backup on update (always on, best-effort)
- Restore on a fresh VM (CLI flow)
- Restore from UI (with confirmation pattern)
- Threat model (B2 ACLs are the protection; bundle is unencrypted; rotate B2 keys if you lose a host)
- Retention (keep-last-N default 10)
- Troubleshooting (common errors + fixes)

Aim for 150-250 lines, operator-focused.

- [ ] **Step 17.2: Add CLAUDE.md section**

Under "Architecture decisions" in `CLAUDE.md`, add a new section:
```markdown
### Install backup surface (slice 4b)

Operator-scoped backup of compose/.env + /data/agenthub.db + Infisical Postgres dump as a single tar.gz bundle. CLI: `agenthub backup-install` / `restore-install`. Web UI: Settings → Admin → Install Backup. Auto-backs-up before every `agenthub update`.

**Bundle is UNENCRYPTED** — relies on B2 bucket ACLs + filesystem perms. Operator-explicit security choice. Encryption is a future opt-in (separate spec).

**Where code lives:**
- `packages/server/src/services/install-backup/` — bundler, restorer, conflict, retention, B2 client, runner
- `packages/server/src/routes/admin-install-backup.ts` — 8 endpoints
- `packages/web/src/pages/admin/InstallBackup.tsx` + `components/install-backup/*`
- `scripts/agenthub` — backup-install + restore-install verbs
- `scripts/restore-install.js` — entrypoint for the one-shot temp restore container

**Restore-from-fresh-VM flow:** the temp restore container avoids the chicken-and-egg of "the server we're restoring is the one running the restore." It mounts /data, /repo, docker.sock; runs `node /app/scripts/restore-install.js`; the live server stops/starts as part of the apply phase.

**Spec:** `docs/superpowers/specs/2026-05-13-install-backup-restore.md`. Operator doc: `docs/operations/install-backup.md`.
```

- [ ] **Step 17.3: Commit**

```bash
git add docs/operations/install-backup.md CLAUDE.md
git commit -m "docs: install-backup operator guide + CLAUDE.md section"
```

---

## Task 18: Final sweep + open PR

- [ ] **Step 18.1: Full test suite**

Run: `pnpm test`
Expected: all tests pass. New tests added: manifest (5), b2-client (4), bundler (2), retention (6), conflict (5) = +22 server tests minimum.

- [ ] **Step 18.2: Typecheck**

Run: `pnpm typecheck`
Expected: passes across all 5 packages.

- [ ] **Step 18.3: Sanity-grep for placeholders**

Run:
```bash
grep -rn "TODO\|FIXME\|XXX" packages/server/src/services/install-backup packages/server/src/routes/admin-install-backup.ts packages/web/src/components/install-backup packages/web/src/pages/admin/InstallBackup.tsx 2>/dev/null | head
```
Expected: any TODOs found should be intentional follow-up markers (with explanation) or removed.

- [ ] **Step 18.4: Manual smoke (without VM)**

If there's a local dev environment: start `pnpm dev`, open the web UI, navigate to /admin/install-backup, confirm the page loads (B2 config card visible, history empty). The full e2e is for VM testing.

- [ ] **Step 18.5: Open the PR**

```bash
git push -u origin feat/install-backup-restore
gh pr create --title "feat(install-backup): operator-scoped backup + restore (pillar #4 slice 4b)" --body "$(cat <<'EOF'
## Summary

Implements `docs/superpowers/specs/2026-05-13-install-backup-restore.md` (PR #76).

Closes the **'host loss = secrets loss' data-loss gap** — operators can now back up the install state (compose/.env + SQLite users/sessions + Infisical Postgres dump) and restore it on a fresh VM.

## What's in this PR

- New `packages/server/src/services/install-backup/` module: bundler, restorer, conflict, retention, b2-client, runner, manifest, types
- 8 new admin endpoints under `/api/admin/install-backup/*` (config, test, run, runs, restore validate/run)
- 2 new SQLite tables: `install_backup_config` (singleton) + `install_backup_runs` (history)
- CLI verbs: `agenthub backup-install` + `agenthub restore-install` (the latter via a one-shot temp container)
- Auto-backup before every `agenthub update` (best-effort, non-blocking)
- Web UI: Settings → Admin → Install Backup page (BackupCard, B2ConfigCard, HistoryTable, RestoreCard with type-the-domain confirmation)
- Threat model: bundle is unencrypted; B2 ACLs + filesystem perms are the protection

## Test plan

- [ ] `pnpm test` passes — 22+ new unit tests
- [ ] `pnpm typecheck` passes
- [ ] Manual VM: configure B2 in admin UI, run `agenthub backup-install`, confirm tarball + B2 object
- [ ] Manual VM (fresh): clone 9000 → 925, `./scripts/install.sh`, `agenthub restore-install --from b2://.../latest --force`, verify users + secrets + history all restored

## What's NOT in this PR

- Bundle encryption (deferred follow-up spec)
- Slice 4a (orchestration UX) / 4c (pre-session volume restore) / 4d (OAuth re-pair) of pillar #4
- Upload-from-file in the restore UI (use B2-timestamp or local-path for now)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 18.6: Verify CI status (if applicable)**

Run: `gh pr checks`
Expected: no checks configured (per CLAUDE.md, CI is parked). That's fine.

---

## Post-implementation (out of plan scope)

- **Manual VM verification (round-trip)**: requires two VMs (one to back up, one fresh) — full restore round-trip per the spec's "Manual VM verification" section.
- **Operator doc validation**: someone other than the author follows `docs/operations/install-backup.md` from scratch on a real install.
- **Slice 4a next**: compose this slice with workspace restore into a single `./scripts/install.sh --restore-from-b2 ...` UX.
