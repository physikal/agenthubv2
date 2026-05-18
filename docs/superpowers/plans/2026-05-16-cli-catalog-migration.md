# CLI Catalog Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move coding-agent CLIs (`claude-code`, `opencode`, `codex`) out of the workspace image and into the per-user volume, with first-class "update available" tracking sourced from a server-side npm-registry poll.

**Architecture:** Server holds a 30-min npm-registry poller writing into a new `package_version_cache` table; the existing `installPackage` agent pathway gains an `essentials.ensure` WS message that SessionManager fires post-session-active to auto-install missing essentials into `~/.local/bin`; `GET /api/packages` joins the cache so the Packages UI can surface "Update available — X → Y" badges that reuse the existing install button.

**Tech Stack:** Hono server, Drizzle ORM + better-sqlite3, vitest, React 19 + Tailwind, Node 22, ws.

**Spec:** `docs/superpowers/specs/2026-05-16-cli-catalog-migration-design.md` (commit `fc13bc0`).

---

## File Map

**Server — new files:**
- `packages/server/src/services/packages/version-check.ts` — npm-registry HTTP fetch + dispatch by install method
- `packages/server/src/services/packages/version-check.test.ts` — parser + error-mode units
- `packages/server/src/services/packages/poller.ts` — 30-min `VersionPoller` class
- `packages/server/src/services/packages/poller.test.ts` — tick idempotency + schedule
- `packages/server/src/services/packages/semver-cmp.ts` — hand-rolled `isNewer(a, b)` (no new dep)
- `packages/server/src/services/packages/semver-cmp.test.ts` — comparison cases

**Server — modified:**
- `packages/server/src/services/packages/catalog.ts` — add `essential?: boolean`; flip claude-code/opencode/codex; drop `isBuiltin` on all entries
- `packages/server/src/services/packages/catalog.test.ts` — replace built-ins assertion with essentials assertion
- `packages/server/src/services/packages/manager.ts` — strip `preinstalled` state + `isBuiltin` short-circuits; surface `latestVersion`/`updateAvailable`/`versionCheckedAt`/`versionCheckError`
- `packages/server/src/db/schema.ts` — add `packageVersionCache` table + types
- `packages/server/src/db/index.ts` — add `CREATE TABLE` for `package_version_cache`
- `packages/server/src/routes/packages.ts` — drop `isBuiltin` from `/catalog`; (no other change — manager surfaces cache fields)
- `packages/server/src/services/session-manager.ts` — `ensureEssentialsForSession` + post-active call
- `packages/server/src/index.ts` — boot `VersionPoller` after `initDb()`

**Agent — new files:**
- `packages/agent/src/packages-protocol.ts` — `EssentialsInbound`/`EssentialsOutbound` types
- `packages/agent/src/essentials.ts` — `ensureEssentials()` routine
- `packages/agent/src/essentials.test.ts` — idempotency + per-package failure isolation

**Agent — modified:**
- `packages/agent/src/ws-server.ts` — route `essentials.*` messages to a router, parallel to auth router
- `packages/agent/src/index.ts` — wire `EssentialsHandler` to the router

**Web — modified:**
- `packages/web/src/pages/Packages.tsx` — drop `preinstalled` state; surface `latestVersion`/`updateAvailable`/`versionCheckedAt`/`versionCheckError`; "Update available" badge; "Update" button replaces "Install" when applicable

**Docker — modified:**
- `docker/Dockerfile.agent-workspace` — remove `npm install -g …` block (claude-code / opencode / mmx-cli); remove `gh-agenthub-wrapper.sh` COPY + chmod
- `docker/claude-minimax-wrapper.sh` — resolve `claude` from `~/.local/bin` first, fall back to PATH

**Files deleted:**
- `docker/gh-agenthub-wrapper.sh` — wrapper deprecated by PR #90 Integrations Connect flow

---

## Conventions used in this plan

- **Branch:** `feat/cli-catalog-migration`
- **Commit style:** Imperative, ≤72 chars, no co-author trailer (per project convention — current commits on `main` do not use one)
- **Tests:** `pnpm --filter @agenthub/<pkg> exec vitest run path/to/file.test.ts` for single files; `pnpm test` to run all suites; `pnpm typecheck` before declaring any task done
- **Order:** Bottom-up (data layer → server services → agent → SessionManager wiring → UI → Docker). Each task is independently committable, but later tasks assume earlier ones landed.

---

## Task 1: Add `essential` flag + drop `isBuiltin` from catalog

**Files:**
- Modify: `packages/server/src/services/packages/catalog.ts`
- Modify: `packages/server/src/services/packages/catalog.test.ts`

- [ ] **Step 1: Update `catalog.test.ts` to assert the new essentials shape**

Replace the file with:

```ts
import { describe, expect, it } from "vitest";
import { listCatalog, getPackage } from "./catalog.js";

describe("package catalog", () => {
  it("marks claude-code, opencode, and codex as essentials", () => {
    const essentials = listCatalog().filter((m) => m.essential);
    expect(essentials.map((m) => m.id).sort()).toEqual([
      "claude-code",
      "codex",
      "opencode",
    ]);
  });

  it("contains MiniMax and Droid as non-essential opt-ins", () => {
    const minimax = getPackage("minimax");
    const droid = getPackage("droid");
    expect(minimax?.essential).toBeFalsy();
    expect(droid?.essential).toBeFalsy();
    expect(droid?.install.method).toBe("curl-sh");
  });

  it("no manifest is marked isBuiltin anymore", () => {
    for (const m of listCatalog()) {
      expect(m.isBuiltin).toBeFalsy();
    }
  });

  it("every manifest has a valid slug, binName, and versionCmd", () => {
    const slug = /^[a-z][a-z0-9-]{0,63}$/;
    const binName = /^[A-Za-z0-9._-]{1,64}$/;
    for (const m of listCatalog()) {
      expect(slug.test(m.id)).toBe(true);
      expect(binName.test(m.binName)).toBe(true);
      expect(m.versionCmd.length).toBeGreaterThan(0);
    }
  });

  it("non-npm install URLs are https-only", () => {
    for (const m of listCatalog()) {
      if (m.install.method === "curl-sh") {
        expect(m.install.scriptUrl.startsWith("https://")).toBe(true);
      } else if (m.install.method === "binary") {
        expect(m.install.url.startsWith("https://")).toBe(true);
      }
    }
  });

  it("getPackage returns undefined for unknown ids", () => {
    expect(getPackage("does-not-exist")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/packages/catalog.test.ts`
Expected: FAIL — `essentials` is empty (`essential` is not on the manifest yet), and three entries still have `isBuiltin: true`.

- [ ] **Step 3: Update `catalog.ts` to add `essential` + flip flags**

Apply these surgical edits to `packages/server/src/services/packages/catalog.ts`:

1. In `PackageManifest`, replace the `isBuiltin?: boolean` field with:

```ts
  /** Pre-installed in image. Remove is refused at the server. */
  isBuiltin?: boolean;
  /** Auto-installed by the agent daemon on session-active if missing. */
  essential?: boolean;
```

(Keep `isBuiltin` in the type — manager + UI still read it during the transition; we just stop setting it. It can be deleted entirely in a follow-up cleanup pass once nothing references it.)

2. Update the file header comment to match the new reality (replace the existing comment block at the top with):

```ts
/**
 * Installable coding-agent CLI catalog.
 *
 * Essentials (essential: true) are auto-installed into the user's
 * /home/coder/.local/bin by the agent daemon on every session-active.
 * Idempotent: an already-present binary is skipped. Non-essential
 * entries (e.g. MiniMax, Droid) install only when the user clicks
 * "Install" in the Packages page.
 *
 * Adding a new installable package: append a manifest entry here.
 * The install command templates live in
 * `packages/agent/src/package-ops.ts` — this file only describes WHAT
 * to install, not HOW.
 */
```

3. Update each entry in `MANIFESTS`:

```ts
const MANIFESTS: readonly PackageManifest[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Anthropic's official coding agent CLI.",
    homepage: "https://docs.claude.com/en/docs/claude-code/overview",
    essential: true,
    binName: "claude",
    versionCmd: ["claude", "--version"],
    install: { method: "npm", npmPackage: "@anthropic-ai/claude-code" },
  },
  {
    id: "opencode",
    name: "OpenCode",
    description: "Multi-model coding agent CLI.",
    homepage: "https://opencode.ai",
    essential: true,
    binName: "opencode",
    versionCmd: ["opencode", "--version"],
    install: { method: "npm", npmPackage: "opencode-ai" },
  },
  {
    id: "minimax",
    name: "MiniMax",
    description: "MiniMax agent CLI (invoked via `mmx` or `claude-minimax`).",
    homepage: "https://www.minimax.io",
    binName: "mmx",
    versionCmd: ["mmx", "--version"],
    install: { method: "npm", npmPackage: "mmx-cli" },
  },
  {
    id: "droid",
    name: "Droid (Factory AI)",
    description: "Factory AI's autonomous coding agent CLI.",
    homepage: "https://app.factory.ai",
    binName: "droid",
    versionCmd: ["droid", "--version"],
    install: {
      method: "curl-sh",
      scriptUrl: "https://app.factory.ai/cli",
    },
  },
  {
    id: "codex",
    name: "OpenAI Codex",
    description: "OpenAI's official Codex coding agent CLI.",
    homepage: "https://github.com/openai/codex",
    essential: true,
    binName: "codex",
    versionCmd: ["codex", "--version"],
    install: { method: "npm", npmPackage: "@openai/codex" },
  },
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/packages/catalog.test.ts`
Expected: PASS — six tests.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS (no type errors introduced).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/packages/catalog.ts \
        packages/server/src/services/packages/catalog.test.ts
git commit -m "packages(catalog): replace isBuiltin with essential flag"
```

---

## Task 2: Add `packageVersionCache` table

**Files:**
- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/db/index.ts`

- [ ] **Step 1: Add the table definition + types**

Append to `packages/server/src/db/schema.ts` just before the `export type User = …` block:

```ts
/**
 * Latest-version cache populated by the server-side npm-registry poller.
 * One row per catalog package id (text PK). Not user-scoped — version
 * info is identical for every user on this AgentHub install.
 *
 * On every poll tick:
 *   - success: latestVersion set, error cleared
 *   - failure: latestVersion left at last-good value, error populated
 */
export const packageVersionCache = sqliteTable("package_version_cache", {
  packageId: text("package_id").primaryKey(),
  latestVersion: text("latest_version"),
  checkedAt: integer("checked_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  error: text("error"),
});
```

And append to the type exports at the bottom:

```ts
export type PackageVersionCache = typeof packageVersionCache.$inferSelect;
export type NewPackageVersionCache = typeof packageVersionCache.$inferInsert;
```

- [ ] **Step 2: Add the DDL to `initDb()`**

In `packages/server/src/db/index.ts`, append to the `sqlite.exec(\`...\`)` block right after the `CREATE TABLE IF NOT EXISTS agent_auth_audit (...)` block but before the closing backtick:

```sql

    CREATE TABLE IF NOT EXISTS package_version_cache (
      package_id TEXT PRIMARY KEY,
      latest_version TEXT,
      checked_at INTEGER NOT NULL,
      error TEXT
    );
```

(No FK, no index — the table is tiny and only read by `getRows()` / single-row joins.)

- [ ] **Step 3: Verify typecheck still passes**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Verify all existing tests still pass**

Run: `pnpm --filter @agenthub/server exec vitest run`
Expected: PASS — no behavioral change yet.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db/schema.ts packages/server/src/db/index.ts
git commit -m "db: add package_version_cache table"
```

---

## Task 3: Hand-rolled semver comparison helper

**Files:**
- Create: `packages/server/src/services/packages/semver-cmp.ts`
- Create: `packages/server/src/services/packages/semver-cmp.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/services/packages/semver-cmp.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isNewer } from "./semver-cmp.js";

describe("isNewer", () => {
  it("returns true when major increases", () => {
    expect(isNewer("2.0.0", "1.9.9")).toBe(true);
  });

  it("returns true when minor increases", () => {
    expect(isNewer("1.2.0", "1.1.99")).toBe(true);
  });

  it("returns true when patch increases", () => {
    expect(isNewer("1.0.43", "1.0.40")).toBe(true);
  });

  it("returns false when versions are equal", () => {
    expect(isNewer("1.0.40", "1.0.40")).toBe(false);
  });

  it("returns false when latest is older", () => {
    expect(isNewer("1.0.39", "1.0.40")).toBe(false);
  });

  it("tolerates a leading v", () => {
    expect(isNewer("v1.0.43", "1.0.40")).toBe(true);
    expect(isNewer("1.0.43", "v1.0.40")).toBe(true);
  });

  it("treats a prerelease as older than the same release", () => {
    expect(isNewer("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(isNewer("1.0.0-rc.1", "1.0.0")).toBe(false);
  });

  it("treats prereleases ordinally by string compare", () => {
    expect(isNewer("1.0.0-rc.2", "1.0.0-rc.1")).toBe(true);
    expect(isNewer("1.0.0-rc.1", "1.0.0-rc.2")).toBe(false);
  });

  it("returns false when either argument is null or unparseable", () => {
    expect(isNewer(null, "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", null)).toBe(false);
    expect(isNewer("not-a-version", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", "not-a-version")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/packages/semver-cmp.test.ts`
Expected: FAIL — module `semver-cmp` does not exist.

- [ ] **Step 3: Implement the helper**

Create `packages/server/src/services/packages/semver-cmp.ts`:

```ts
/**
 * Minimal semver "is a newer than b" check for npm-registry-shaped version
 * strings. We don't pull `semver` as a dep because:
 *   - the version strings we compare are well-behaved (npm "latest" tags)
 *   - we only need "is newer" — not range matching, not coercion, etc.
 *
 * Rules:
 *   - Strip an optional leading `v`.
 *   - Compare major.minor.patch numerically.
 *   - A version without a prerelease sorts after one with a prerelease at
 *     the same major.minor.patch (per semver §11). Prereleases compare
 *     lexicographically — good enough for "rc.1 < rc.2".
 *   - Anything that fails to parse → return false (caller treats as "no
 *     update available", which is the safe default).
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

interface Parsed {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

function parse(input: string): Parsed | null {
  const m = VERSION_RE.exec(input.trim());
  if (!m) return null;
  const [, major, minor, patch, prerelease] = m;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ?? null,
  };
}

export function isNewer(latest: string | null, current: string | null): boolean {
  if (latest === null || current === null) return false;
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;

  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;

  // Same major.minor.patch. A release > a prerelease; otherwise lex compare.
  if (a.prerelease === null && b.prerelease === null) return false;
  if (a.prerelease === null && b.prerelease !== null) return true;
  if (a.prerelease !== null && b.prerelease === null) return false;
  return (a.prerelease ?? "") > (b.prerelease ?? "");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/packages/semver-cmp.test.ts`
Expected: PASS — nine `it` blocks.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/packages/semver-cmp.ts \
        packages/server/src/services/packages/semver-cmp.test.ts
git commit -m "packages: add hand-rolled isNewer semver helper"
```

---

## Task 4: `version-check.ts` — dispatch by install method

**Files:**
- Create: `packages/server/src/services/packages/version-check.ts`
- Create: `packages/server/src/services/packages/version-check.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/services/packages/version-check.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkVersion } from "./version-check.js";

describe("checkVersion (npm)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("returns the version on a 200 with a version field", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: "1.2.3" }), { status: 200 }),
    ) as typeof fetch;
    const res = await checkVersion({ method: "npm", npmPackage: "@anthropic-ai/claude-code" });
    expect(res).toEqual({ latest: "1.2.3" });
  });

  it("returns an error string on non-200", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("not found", { status: 404 }),
    ) as typeof fetch;
    const res = await checkVersion({ method: "npm", npmPackage: "no-such-pkg" });
    expect("error" in res).toBe(true);
  });

  it("returns an error when the response has no version field", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    ) as typeof fetch;
    const res = await checkVersion({ method: "npm", npmPackage: "@anthropic-ai/claude-code" });
    expect("error" in res).toBe(true);
  });

  it("returns an error when fetch throws (network failure)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as typeof fetch;
    const res = await checkVersion({ method: "npm", npmPackage: "@anthropic-ai/claude-code" });
    expect("error" in res).toBe(true);
  });

  it("URL-encodes scoped npm package names", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    await checkVersion({ method: "npm", npmPackage: "@openai/codex" });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe("https://registry.npmjs.org/%40openai%2Fcodex/latest");
  });
});

describe("checkVersion (other methods)", () => {
  it("returns an error for curl-sh", async () => {
    const res = await checkVersion({
      method: "curl-sh",
      scriptUrl: "https://app.factory.ai/cli",
    });
    expect("error" in res).toBe(true);
  });

  it("returns an error for binary", async () => {
    const res = await checkVersion({
      method: "binary",
      url: "https://example.com/bin.tar.gz",
    });
    expect("error" in res).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/packages/version-check.test.ts`
Expected: FAIL — module `version-check` does not exist.

- [ ] **Step 3: Implement `checkVersion`**

Create `packages/server/src/services/packages/version-check.ts`:

```ts
import type { InstallSpec } from "./catalog.js";

export type VersionCheckResult =
  | { latest: string }
  | { error: string };

/**
 * Resolve the upstream "latest" version for a given install spec.
 *
 * npm           → registry.npmjs.org/<pkg>/latest
 * curl-sh       → no reliable upstream version source (script content
 *                 carries no semver) — caller treats as "unknown"
 * binary        → same as curl-sh; reserved for future github-release
 *                 dispatch if/when we add tools with GH-release installers
 */
export async function checkVersion(spec: InstallSpec): Promise<VersionCheckResult> {
  if (spec.method === "npm") return checkNpm(spec.npmPackage);
  return { error: `no version source for install method ${spec.method}` };
}

async function checkNpm(pkg: string): Promise<VersionCheckResult> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { error: `npm ${pkg}: HTTP ${String(res.status)}` };
    const body = (await res.json()) as { version?: string };
    if (!body.version) return { error: `npm ${pkg}: no version in response` };
    return { latest: body.version };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `npm ${pkg}: ${msg}` };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/packages/version-check.test.ts`
Expected: PASS — seven `it` blocks.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/packages/version-check.ts \
        packages/server/src/services/packages/version-check.test.ts
git commit -m "packages: add version-check (npm registry)"
```

---

## Task 5: `poller.ts` — scheduled tick + cache upsert

**Files:**
- Create: `packages/server/src/services/packages/poller.ts`
- Create: `packages/server/src/services/packages/poller.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/services/packages/poller.test.ts`:

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema, initDb } from "../../db/index.js";
import { VersionPoller } from "./poller.js";

// Server tests run against an in-memory SQLite (test/setup.ts sets
// DB_PATH=:memory:). The singleton in db/index.ts is created on first
// import, but its tables only exist after initDb() runs. Call it once
// here so the package_version_cache table exists before any test.
beforeAll(() => {
  initDb();
});

describe("VersionPoller.tick", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.delete(schema.packageVersionCache).run();
  });

  beforeEach(() => {
    db.delete(schema.packageVersionCache).run();
  });

  it("upserts a success row for each npm-method catalog entry", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      // Return a deterministic version derived from the package slug so each
      // upsert is distinguishable.
      const slug = decodeURIComponent(url.split("/").slice(-2, -1)[0] ?? "");
      return new Response(JSON.stringify({ version: `1.${slug.length}.0` }), { status: 200 });
    }) as typeof fetch;

    const poller = new VersionPoller();
    await poller.tick();

    const rows = db.select().from(schema.packageVersionCache).all();
    // claude-code, opencode, minimax, codex are npm; droid is curl-sh.
    const ids = rows.map((r) => r.packageId).sort();
    expect(ids).toEqual(["claude-code", "codex", "droid", "minimax", "opencode"]);
    const claude = rows.find((r) => r.packageId === "claude-code");
    expect(claude?.latestVersion).toMatch(/^1\.\d+\.0$/);
    expect(claude?.error).toBeNull();
  });

  it("records an error row when fetch fails, preserving last-good version", async () => {
    db.insert(schema.packageVersionCache).values({
      packageId: "claude-code",
      latestVersion: "1.0.42",
      checkedAt: new Date(Date.now() - 60_000),
      error: null,
    }).run();

    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network unreachable")) as typeof fetch;
    const poller = new VersionPoller();
    await poller.tick();

    const row = db.select().from(schema.packageVersionCache)
      .where(eq(schema.packageVersionCache.packageId, "claude-code"))
      .get();
    expect(row?.error).toMatch(/network unreachable/);
    // Last-good version preserved.
    expect(row?.latestVersion).toBe("1.0.42");
  });

  it("clears a previously-stored error on a subsequent success", async () => {
    db.insert(schema.packageVersionCache).values({
      packageId: "claude-code",
      latestVersion: null,
      checkedAt: new Date(Date.now() - 60_000),
      error: "stale failure",
    }).run();

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: "1.0.50" }), { status: 200 }),
    ) as typeof fetch;
    const poller = new VersionPoller();
    await poller.tick();

    const row = db.select().from(schema.packageVersionCache)
      .where(eq(schema.packageVersionCache.packageId, "claude-code"))
      .get();
    expect(row?.error).toBeNull();
    expect(row?.latestVersion).toBe("1.0.50");
  });
});

describe("VersionPoller.start / stop", () => {
  it("ticks once immediately and schedules an interval", async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 }),
      ) as typeof fetch;
      const poller = new VersionPoller(60_000);
      const tickSpy = vi.spyOn(poller, "tick");
      poller.start();
      // start() fires an immediate tick (void).
      expect(tickSpy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      expect(tickSpy).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(60_000);
      expect(tickSpy).toHaveBeenCalledTimes(3);
      poller.stop();
      vi.advanceTimersByTime(60_000);
      expect(tickSpy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/packages/poller.test.ts`
Expected: FAIL — module `poller` does not exist.

- [ ] **Step 3: Implement `VersionPoller`**

Create `packages/server/src/services/packages/poller.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/packages/poller.test.ts`
Expected: PASS — four `it` blocks.

(If the schedule test flakes because of vitest's worker isolation around `setInterval`, ensure the test sets `vi.useFakeTimers()` before constructing the poller. The above already does this.)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/packages/poller.ts \
        packages/server/src/services/packages/poller.test.ts
git commit -m "packages: add VersionPoller (30-min npm-registry sweep)"
```

---

## Task 6: Boot the poller from `server/src/index.ts`

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Import and start the poller**

In `packages/server/src/index.ts`:

1. Add an import alongside the other service imports (around line 19):

```ts
import { VersionPoller } from "./services/packages/poller.js";
```

2. After the `const packageManager = new PackageManager(sessionManager);` line, add:

```ts
// Periodically poll upstream registries for fresh CLI versions. Writes into
// package_version_cache; the Packages page reads from there. Tick interval
// is 30 minutes — npm doesn't publish often enough to warrant tighter.
const versionPoller = new VersionPoller();
versionPoller.start();
```

3. In the `shutdown` function, before `server.close();`, add:

```ts
  versionPoller.stop();
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Run all server tests to confirm no regressions**

Run: `pnpm --filter @agenthub/server exec vitest run`
Expected: PASS — every existing suite plus the new ones.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "server: start VersionPoller after initDb"
```

---

## Task 7: Surface `latestVersion` / `updateAvailable` on `GET /api/packages`

**Files:**
- Modify: `packages/server/src/services/packages/manager.ts`

- [ ] **Step 1: Extend the response type and `listForUser`**

In `packages/server/src/services/packages/manager.ts`:

1. Update `CatalogState` — drop `"preinstalled"`:

```ts
export type CatalogState =
  | "not-installed"
  | "installing"
  | "ready"
  | "removing"
  | "error";
```

2. Extend `CatalogEntry`:

```ts
export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  homepage?: string;
  /** True if marked essential in the catalog — auto-installed by daemon. */
  essential: boolean;
  state: CatalogState;
  /** Daemon-reported version from /home/coder/.local/bin (post-install). */
  version?: string | null;
  error?: string | null;
  updatedAt?: string | null;
  /** Upstream latest (from package_version_cache). null if never checked. */
  latestVersion?: string | null;
  /** True when latestVersion > version (semver). */
  updateAvailable?: boolean;
  /** ISO timestamp of the last poller tick that touched this row. */
  versionCheckedAt?: string | null;
  /** Last poller error string, if any. */
  versionCheckError?: string | null;
}
```

3. Update the imports at the top:

```ts
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import type { UserPackage, UserPackageStatus, PackageVersionCache } from "../../db/schema.js";
import type {
  PackageOpParams,
  PackageOpResult,
  SessionManager,
} from "../session-manager.js";
import { getPackage, listCatalog, type PackageManifest } from "./catalog.js";
import { isNewer } from "./semver-cmp.js";
```

4. Replace `listForUser` and `getStatus` with versions that join the cache:

```ts
  listForUser(userId: string): CatalogEntry[] {
    const rows = this.getRowsForUser(userId);
    const byPackage = new Map<string, UserPackage>();
    for (const r of rows) byPackage.set(r.packageId, r);

    const cacheRows = db.select().from(schema.packageVersionCache).all();
    const byCache = new Map<string, PackageVersionCache>();
    for (const r of cacheRows) byCache.set(r.packageId, r);

    return listCatalog().map((manifest) =>
      this.toEntry(manifest, byPackage.get(manifest.id), byCache.get(manifest.id)),
    );
  }

  getStatus(userId: string, packageId: string): CatalogEntry | null {
    const manifest = getPackage(packageId);
    if (!manifest) return null;
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
    const cache = db
      .select()
      .from(schema.packageVersionCache)
      .where(eq(schema.packageVersionCache.packageId, packageId))
      .get();
    return this.toEntry(manifest, row, cache);
  }

  private toEntry(
    manifest: PackageManifest,
    row: UserPackage | undefined,
    cache: PackageVersionCache | undefined,
  ): CatalogEntry {
    const base: CatalogEntry = {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      essential: Boolean(manifest.essential),
      state: "not-installed",
    };
    if (manifest.homepage !== undefined) base.homepage = manifest.homepage;
    if (row) {
      base.state = mapRowStatusToState(row.status);
      base.version = row.version ?? null;
      base.error = row.error ?? null;
      base.updatedAt = row.updatedAt.toISOString();
    }
    if (cache) {
      base.latestVersion = cache.latestVersion ?? null;
      base.versionCheckedAt = cache.checkedAt.toISOString();
      base.versionCheckError = cache.error ?? null;
      base.updateAvailable = isNewer(cache.latestVersion, base.version ?? null);
    }
    return base;
  }
```

5. Drop the `manifest.isBuiltin` short-circuits in `startInstall` and `startRemove`. The full edits:

```ts
  async startInstall(
    userId: string,
    packageId: string,
  ): Promise<{ status: "started"; state: CatalogState } | { status: "conflict"; reason: string }> {
    const manifest = getPackage(packageId);
    if (!manifest) return { status: "conflict", reason: "unknown package" };

    const existing = this.getRow(userId, packageId);
    if (existing) {
      if (existing.status === "installing") {
        return { status: "conflict", reason: "install already in progress" };
      }
      if (existing.status === "removing") {
        return { status: "conflict", reason: "remove in progress" };
      }
      // NB: "ready" is no longer a conflict — re-install is how we upgrade.
    }
    // ... rest of the method body is unchanged
```

(The "already installed" conflict is intentionally dropped so the Update button can POST `/install` to upgrade in place.)

```ts
  async startRemove(
    userId: string,
    packageId: string,
  ): Promise<{ status: "started"; state: CatalogState } | { status: "conflict"; reason: string } | { status: "not-found" }> {
    const manifest = getPackage(packageId);
    if (!manifest) return { status: "conflict", reason: "unknown package" };

    const existing = this.getRow(userId, packageId);
    if (!existing) return { status: "not-found" };
    // ... rest is unchanged
```

(Drop the `manifest.isBuiltin → "cannot be removed"` branch.)

6. Drop the `mapRowStatusToState`'s `case "preinstalled"` — nothing produces that status, but ensure the switch type-checks. Replace the bottom-of-file helper:

```ts
function mapRowStatusToState(status: UserPackageStatus): CatalogState {
  switch (status) {
    case "installing": return "installing";
    case "ready":      return "ready";
    case "removing":   return "removing";
    case "error":      return "error";
  }
}
```

(No change actually needed — `UserPackageStatus` never included "preinstalled". Confirm by reading the current file.)

- [ ] **Step 2: Update the `/api/packages/catalog` route to drop `isBuiltin`**

In `packages/server/src/routes/packages.ts`, change:

```ts
  app.get("/catalog", (c) => {
    return c.json(
      listCatalog().map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        homepage: m.homepage,
        essential: Boolean(m.essential),
      })),
    );
  });
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Run all server tests**

Run: `pnpm --filter @agenthub/server exec vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/packages/manager.ts \
        packages/server/src/routes/packages.ts
git commit -m "packages: surface latestVersion + updateAvailable on /api/packages"
```

---

## Task 8: Agent — `packages-protocol.ts`

**Files:**
- Create: `packages/agent/src/packages-protocol.ts`

- [ ] **Step 1: Create the protocol file**

Create `packages/agent/src/packages-protocol.ts`:

```ts
import type { InstallSpec } from "./package-ops.js";

export interface EssentialSpec {
  packageId: string;
  binName: string;
  versionCmd: readonly string[];
  install: InstallSpec;
}

export type PackagesInbound =
  | { type: "essentials.ensure"; specs: EssentialSpec[] };

export type PackagesOutbound =
  | { type: "essentials.line"; packageId: string; line: string }
  | { type: "essentials.result"; packageId: string; ok: boolean; version?: string; error?: string }
  | { type: "essentials.done"; installed: string[]; skipped: string[]; failed: string[] };
```

(The `essentials.line` message lets us stream "installing claude-code…" lines through to terminal scrollback later; `essentials.result` is per-package and `essentials.done` is the summary fired once the whole batch settles.)

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/packages-protocol.ts
git commit -m "agent: add packages-protocol with EssentialSpec + essentials.* msgs"
```

---

## Task 9: Agent — `essentials.ts` with idempotent install loop

**Files:**
- Create: `packages/agent/src/essentials.ts`
- Create: `packages/agent/src/essentials.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agent/src/essentials.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ensureEssentials } from "./essentials.js";
import type { EssentialSpec } from "./packages-protocol.js";

function spec(id: string, bin: string): EssentialSpec {
  return {
    packageId: id,
    binName: bin,
    versionCmd: [bin, "--version"],
    install: { method: "npm", npmPackage: `@scope/${id}` },
  };
}

describe("ensureEssentials", () => {
  it("installs only missing binaries", async () => {
    const present = new Set(["claude"]);
    const install = vi.fn().mockResolvedValue({ ok: true, version: "1.0.0" });
    const log = vi.fn();

    const result = await ensureEssentials(
      [spec("claude-code", "claude"), spec("opencode", "opencode"), spec("codex", "codex")],
      {
        binExists: async (bin) => present.has(bin),
        install,
        log,
      },
    );

    expect(install).toHaveBeenCalledTimes(2);
    expect(install.mock.calls.map((c) => (c[0] as EssentialSpec).packageId).sort()).toEqual([
      "codex", "opencode",
    ]);
    expect(result.installed.sort()).toEqual(["codex", "opencode"]);
    expect(result.skipped).toEqual(["claude-code"]);
    expect(result.failed).toEqual([]);
  });

  it("is a no-op when every binary already exists", async () => {
    const install = vi.fn();
    const log = vi.fn();
    const result = await ensureEssentials(
      [spec("claude-code", "claude")],
      { binExists: async () => true, install, log },
    );
    expect(install).not.toHaveBeenCalled();
    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual(["claude-code"]);
  });

  it("reports per-package failures without aborting siblings", async () => {
    const install = vi.fn().mockImplementation(async (s: EssentialSpec) => {
      if (s.packageId === "opencode") return { ok: false, error: "npm 503" };
      return { ok: true, version: "1.0.0" };
    });
    const log = vi.fn();

    const result = await ensureEssentials(
      [spec("claude-code", "claude"), spec("opencode", "opencode"), spec("codex", "codex")],
      { binExists: async () => false, install, log },
    );
    expect(install).toHaveBeenCalledTimes(3);
    expect(result.installed.sort()).toEqual(["claude-code", "codex"]);
    expect(result.failed).toEqual(["opencode"]);
  });

  it("handles install thrown errors as per-package failures", async () => {
    const install = vi.fn().mockRejectedValue(new Error("disk full"));
    const log = vi.fn();
    const result = await ensureEssentials(
      [spec("claude-code", "claude")],
      { binExists: async () => false, install, log },
    );
    expect(result.failed).toEqual(["claude-code"]);
    expect(result.installed).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agenthub/agent exec vitest run src/essentials.test.ts`
Expected: FAIL — module `essentials` does not exist.

- [ ] **Step 3: Implement `ensureEssentials`**

Create `packages/agent/src/essentials.ts`:

```ts
import { access } from "node:fs/promises";
import { installPackage, type PackageOpResult } from "./package-ops.js";
import type { EssentialSpec } from "./packages-protocol.js";

const LOCAL_BIN = "/home/coder/.local/bin";

export interface EnsureEssentialsDeps {
  /** Check whether a binary exists in /home/coder/.local/bin. */
  binExists: (binName: string) => Promise<boolean>;
  /** Install one essential. Defaults to the real `installPackage`. */
  install: (spec: EssentialSpec) => Promise<PackageOpResult>;
  /** Log line emitter — wired to WS-out by the caller. */
  log: (line: string) => void;
}

export interface EnsureEssentialsResult {
  installed: string[];
  skipped: string[];
  failed: string[];
}

const defaultDeps: EnsureEssentialsDeps = {
  binExists: defaultBinExists,
  install: (spec) =>
    installPackage({
      packageId: spec.packageId,
      binName: spec.binName,
      versionCmd: spec.versionCmd,
      spec: spec.install,
    }),
  log: () => undefined,
};

async function defaultBinExists(binName: string): Promise<boolean> {
  try {
    await access(`${LOCAL_BIN}/${binName}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * For each essential, if its binary is missing from /home/coder/.local/bin,
 * install it. Runs installs in parallel — a single npm install is mostly
 * I/O-bound and the workspace has spare CPU. Per-package failures are
 * collected and do not abort siblings.
 *
 * Idempotent: running twice in succession is cheap (just stat() calls).
 */
export async function ensureEssentials(
  specs: readonly EssentialSpec[],
  depsOverride: Partial<EnsureEssentialsDeps> = {},
): Promise<EnsureEssentialsResult> {
  const deps: EnsureEssentialsDeps = { ...defaultDeps, ...depsOverride };
  const skipped: string[] = [];
  const missing: EssentialSpec[] = [];

  for (const s of specs) {
    if (await deps.binExists(s.binName)) {
      skipped.push(s.packageId);
    } else {
      missing.push(s);
    }
  }

  if (missing.length === 0) {
    return { installed: [], skipped, failed: [] };
  }

  deps.log(`[essentials] installing: ${missing.map((m) => m.packageId).join(", ")}`);

  const installed: string[] = [];
  const failed: string[] = [];

  await Promise.all(
    missing.map(async (s) => {
      try {
        const result = await deps.install(s);
        if (result.ok) {
          installed.push(s.packageId);
          deps.log(`[essentials] ${s.packageId} installed${result.version ? ` (${result.version})` : ""}`);
        } else {
          failed.push(s.packageId);
          deps.log(`[essentials] ${s.packageId} failed: ${result.error ?? "unknown error"}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failed.push(s.packageId);
        deps.log(`[essentials] ${s.packageId} failed: ${msg}`);
      }
    }),
  );

  return { installed, skipped, failed };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @agenthub/agent exec vitest run src/essentials.test.ts`
Expected: PASS — four `it` blocks.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/essentials.ts packages/agent/src/essentials.test.ts
git commit -m "agent: add ensureEssentials with idempotent parallel install"
```

---

## Task 10: Agent WS — route `essentials.*` messages

**Files:**
- Modify: `packages/agent/src/ws-server.ts`
- Modify: `packages/agent/src/index.ts`

- [ ] **Step 1: Extend `ws-server.ts` to accept a packages router**

In `packages/agent/src/ws-server.ts`:

1. Add an import alongside the auth-protocol import:

```ts
import type { PackagesInbound, PackagesOutbound } from "./packages-protocol.js";
```

2. Extend `InboundMessage` and `OutboundMessage`:

```ts
type InboundMessage =
  | { type: "start" }
  | { type: "upload"; name: string; data: string }
  | { type: "stop" }
  | { type: "backup"; op: "save" | "restore" | "size"; requestId: string; params: BackupParams }
  | { type: "package"; op: "install" | "remove"; requestId: string; params: PackageOpParams }
  | AuthInbound
  | PackagesInbound;

type OutboundMessage =
  | { type: "status"; state: string; detail: string }
  | { type: "ready"; hostname: string }
  | { type: "error"; message: string }
  | { type: "backup-result"; /* ... unchanged ... */ }
  | { type: "package-result"; /* ... unchanged ... */ }
  | AuthOutbound
  | PackagesOutbound;
```

(Keep the existing body fields for `backup-result` and `package-result` — only the union list changes.)

3. Add a packages router parallel to the auth router. Just after the existing `private authRouter: ...` field:

```ts
  private packagesRouter: ((msg: PackagesInbound) => Promise<void>) | null = null;

  public setPackagesRouter(fn: (msg: PackagesInbound) => Promise<void>): void {
    this.packagesRouter = fn;
  }
```

4. In `handleMessage`, add a prefix check after the existing `auth.` one:

```ts
  private handleMessage(msg: InboundMessage): void {
    if (typeof msg.type === "string" && msg.type.startsWith("auth.")) {
      if (this.authRouter) void this.authRouter(msg as AuthInbound);
      return;
    }
    if (typeof msg.type === "string" && msg.type.startsWith("essentials.")) {
      if (this.packagesRouter) void this.packagesRouter(msg as PackagesInbound);
      return;
    }
    switch (msg.type) {
      // ... unchanged
    }
  }
```

- [ ] **Step 2: Wire the handler in `agent/src/index.ts`**

Add an import and the wiring after the existing `AuthHandler` setup. The full new block in `packages/agent/src/index.ts`, immediately after `server.setAuthRouter((m) => authHandler.handle(m));`:

```ts
import { ensureEssentials } from "./essentials.js";
import type { PackagesInbound } from "./packages-protocol.js";

// ... existing AuthHandler wiring ...

server.setPackagesRouter(async (msg: PackagesInbound) => {
  if (msg.type !== "essentials.ensure") return;
  const result = await ensureEssentials(msg.specs, {
    log: (line) => {
      // Per-line stream: surface to scrollback via auth-style line msg.
      // The simplest route is just to log; later phases can fan out a
      // dedicated essentials.line WS message if we want UI tail.
      console.log(line);
      server.send({
        type: "essentials.line",
        packageId: "*",
        line,
      });
    },
  });
  server.send({
    type: "essentials.done",
    installed: result.installed,
    skipped: result.skipped,
    failed: result.failed,
  });
});
```

(Move the two `import` statements to the top of the file with the other imports — they appear inline above only for clarity. The actual file should keep all imports at the top.)

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Run agent tests**

Run: `pnpm --filter @agenthub/agent exec vitest run`
Expected: PASS — every existing test plus the new `essentials.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/ws-server.ts packages/agent/src/index.ts
git commit -m "agent: route essentials.* WS messages to ensureEssentials"
```

---

## Task 11: SessionManager — fire `essentials.ensure` on session-active

**Files:**
- Modify: `packages/server/src/services/session-manager.ts`

- [ ] **Step 1: Add `ensureEssentialsForSession` and call it**

In `packages/server/src/services/session-manager.ts`:

1. Import the catalog at the top alongside the other imports:

```ts
import { listCatalog } from "./packages/catalog.js";
```

2. Right after the existing call to `void this.hydrateCredentialsForSession(session.id, session.userId);` (around line 370), add:

```ts
        // Auto-install essentials into /home/coder/.local/bin. Idempotent —
        // the agent skips binaries that already exist. Failures are
        // non-fatal: the user can manually install via Packages.
        this.ensureEssentialsForSession(session.id);
```

3. Add the method to the class (near `packageViaAgent`):

```ts
  private ensureEssentialsForSession(sessionId: string): void {
    const entry = this.agents.get(sessionId);
    if (!entry) return;
    const specs = listCatalog()
      .filter((m) => m.essential === true)
      .map((m) => ({
        packageId: m.id,
        binName: m.binName,
        versionCmd: m.versionCmd,
        install: m.install,
      }));
    if (specs.length === 0) return;
    try {
      entry.ws.send(JSON.stringify({ type: "essentials.ensure", specs }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.warn(`[session ${sessionId}] essentials send failed: ${msg}`);
    }
  }
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Run server tests**

Run: `pnpm --filter @agenthub/server exec vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/services/session-manager.ts
git commit -m "session-manager: fire essentials.ensure on session-active"
```

---

## Task 12: Web UI — surface `latestVersion` + Update button

**Files:**
- Modify: `packages/web/src/pages/Packages.tsx`

- [ ] **Step 1: Update the types and constants**

Replace the top-of-file type block and state maps in `packages/web/src/pages/Packages.tsx` (lines 1–49) with:

```tsx
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";

type CatalogState =
  | "not-installed"
  | "installing"
  | "ready"
  | "removing"
  | "error";

interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  homepage?: string;
  essential: boolean;
  state: CatalogState;
  version?: string | null;
  error?: string | null;
  updatedAt?: string | null;
  latestVersion?: string | null;
  updateAvailable?: boolean;
  versionCheckedAt?: string | null;
  versionCheckError?: string | null;
}

const STATE_DOT: Record<CatalogState, string> = {
  "not-installed": "bg-zinc-700",
  installing: "bg-yellow-400",
  removing: "bg-yellow-400",
  ready: "bg-green-400",
  error: "bg-red-400",
};

const STATE_LABEL: Record<CatalogState, string> = {
  "not-installed": "Not installed",
  installing: "Installing…",
  removing: "Removing…",
  ready: "Installed",
  error: "Install failed",
};

const STATE_COLOR: Record<CatalogState, string> = {
  "not-installed": "text-zinc-500",
  installing: "text-yellow-400",
  removing: "text-yellow-400",
  ready: "text-green-400",
  error: "text-red-400",
};

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${String(m)} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)} h ago`;
  return `${String(Math.floor(h / 24))} d ago`;
}
```

- [ ] **Step 2: Update `PackageCard` to render version + update affordance**

Replace the `PackageCard` body (replace lines 51–193, i.e. everything from `function PackageCard(...)` through the closing `}` before `export function Packages()`) with:

```tsx
function PackageCard({
  entry,
  onChanged,
}: {
  entry: CatalogEntry;
  onChanged: () => void;
}) {
  const [current, setCurrent] = useState(entry);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => setCurrent(entry), [entry]);

  useEffect(() => {
    if (current.state !== "installing" && current.state !== "removing") return;
    const interval = setInterval(async () => {
      try {
        const res = await api(`/api/packages/${current.id}/status`);
        if (!res.ok) return;
        const data = (await res.json()) as CatalogEntry;
        setCurrent(data);
        if (data.state !== "installing" && data.state !== "removing") {
          onChanged();
        }
      } catch { /* retry */ }
    }, 3_000);
    return () => clearInterval(interval);
  }, [current.id, current.state, onChanged]);

  const pulse = current.state === "installing" || current.state === "removing";
  const installed = current.state === "ready" || current.state === "error";
  const updateAvailable = current.updateAvailable === true && installed;
  const canInstall = current.state === "not-installed" || current.state === "error";
  const canUpdate = updateAvailable && current.state !== "installing" && current.state !== "removing";
  const canRemove = current.state === "ready" || current.state === "error";

  const handleInstall = async (verb: "install" | "update") => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api(`/api/packages/${current.id}/install`, { method: "POST" });
      if (res.ok || res.status === 202) {
        setCurrent((prev) => ({ ...prev, state: "installing", error: null }));
      } else {
        const body = (await res.json()) as { error?: string };
        setMessage({ text: body.error ?? `${verb} failed`, error: true });
      }
    } catch {
      setMessage({ text: `${verb} failed`, error: true });
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    if (!confirm(`Remove ${current.name}?`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await api(`/api/packages/${current.id}/remove`, { method: "POST" });
      if (res.ok || res.status === 202) {
        setCurrent((prev) => ({ ...prev, state: "removing" }));
      } else {
        const body = (await res.json()) as { error?: string };
        setMessage({ text: body.error ?? "Remove failed", error: true });
      }
    } catch {
      setMessage({ text: "Remove failed", error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-start justify-between mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span
              className={`w-2 h-2 rounded-full ${STATE_DOT[current.state]} ${pulse ? "animate-pulse" : ""}`}
            />
            <h3 className="font-medium text-zinc-100">{current.name}</h3>
            {current.essential && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                Essential
              </span>
            )}
            {current.version && (
              <code className="text-[10px] text-zinc-500">{current.version}</code>
            )}
            {updateAvailable && current.latestVersion && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/10 border border-yellow-500/30 text-yellow-200">
                Update available — {current.version ?? "?"} → {current.latestVersion}
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500">{current.description}</p>
          {current.homepage && (
            <a
              href={current.homepage}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-purple-400 hover:underline"
            >
              {current.homepage.replace(/^https?:\/\//, "")}
            </a>
          )}
        </div>
        <span className={`text-xs whitespace-nowrap ml-3 ${STATE_COLOR[current.state]}`}>
          {STATE_LABEL[current.state]}
        </span>
      </div>

      {current.error && current.state === "error" && (
        <p className="text-xs text-red-400 mt-1">{current.error}</p>
      )}

      <div className="flex gap-2 mt-3 flex-wrap items-center">
        {canUpdate && (
          <button
            onClick={() => void handleInstall("update")}
            disabled={busy}
            className="px-3 py-1.5 text-xs font-medium bg-yellow-500 text-zinc-900 rounded-lg hover:bg-yellow-400 disabled:opacity-50 transition-colors"
          >
            Update
          </button>
        )}
        {canInstall && !canUpdate && (
          <button
            onClick={() => void handleInstall("install")}
            disabled={busy}
            className="px-3 py-1.5 text-xs font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-50 transition-colors"
          >
            {current.state === "error" ? "Retry install" : "Install"}
          </button>
        )}
        {canRemove && (
          <button
            onClick={() => void handleRemove()}
            disabled={busy}
            className="px-3 py-1.5 text-xs text-red-400 border border-zinc-700 rounded-lg hover:bg-zinc-800 disabled:opacity-50 transition-colors"
          >
            Remove
          </button>
        )}
        {current.versionCheckedAt && (
          <span
            className="text-[10px] text-zinc-600 ml-auto"
            title={current.versionCheckError ?? `Checked ${current.versionCheckedAt}`}
          >
            {current.versionCheckError
              ? "Version check failed"
              : `Last checked ${formatRelative(current.versionCheckedAt)}`}
          </span>
        )}
      </div>

      {message && (
        <p className={`mt-2 text-xs ${message.error ? "text-red-400" : "text-green-400"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Update the Packages page intro copy**

In the `Packages` function (the outer component), replace the intro paragraph (the `<p className="text-sm text-zinc-500 mb-6">…</p>` block) with:

```tsx
      <p className="text-sm text-zinc-500 mb-6">
        Coding-agent CLIs available in your workspace. Installs land in
        <code className="mx-1 text-zinc-400">~/.local/bin</code>
        and persist across sessions. Essentials (Claude Code, OpenCode,
        Codex) auto-install on every new session; everything else is
        opt-in. Update checks run every 30 minutes against the npm
        registry.
      </p>
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Run web lint if defined**

Run: `pnpm --filter @agenthub/web lint 2>/dev/null || echo "no web lint defined — skipping"`
Expected: PASS or skip.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/pages/Packages.tsx
git commit -m "web(packages): show latestVersion + Update affordance"
```

---

## Task 13: Workspace image — drop preinstalled CLIs + gh wrapper

**Files:**
- Modify: `docker/Dockerfile.agent-workspace`
- Delete: `docker/gh-agenthub-wrapper.sh`

- [ ] **Step 1: Remove the npm install block**

In `docker/Dockerfile.agent-workspace`, delete these lines (the block starts around line 68):

```dockerfile
# Global agent tools. Layered AFTER apt to avoid re-pulling large npm blobs
# every time a system package changes.
RUN npm install -g \
      @anthropic-ai/claude-code \
      opencode-ai \
      mmx-cli \
    && npm cache clean --force

```

(Delete the comment, the RUN, and the trailing blank line.)

- [ ] **Step 2: Remove the gh wrapper COPY + chmod**

Delete these lines (around line 147 in the original):

```dockerfile
# `gh` wrapper that bridges the GitHub App install to the GitHub CLI —
# same ephemeral-token approach as the git credential helper, but for
# `gh`'s own auth discovery (GH_TOKEN) since `gh` doesn't read git
# credential helpers. Installed to /usr/local/bin/gh so it shadows
# /usr/bin/gh in PATH. Agents probing `gh auth status` now see
# "authenticated" out of the box instead of "not logged in", stopping
# the "I need you to run gh auth login" chorus.
COPY docker/gh-agenthub-wrapper.sh /usr/local/bin/gh
RUN chmod 0755 /usr/local/bin/gh

```

(Delete the comment block, the COPY, the RUN, and the trailing blank line.)

- [ ] **Step 3: Delete the wrapper file**

Run:

```bash
trash docker/gh-agenthub-wrapper.sh
```

(If `trash` isn't installed, fall back to `rm docker/gh-agenthub-wrapper.sh` — file is committed, easy to recover.)

- [ ] **Step 4: Verify no other code references the deleted file or relies on system claude/opencode/mmx**

Run:

```bash
rg -n "gh-agenthub-wrapper|/usr/local/bin/gh|/usr/bin/mmx|/usr/bin/claude\b|/usr/bin/opencode\b" packages docker scripts docs
```

Expected: hits inside the spec file (`docs/superpowers/specs/2026-05-16-cli-catalog-migration-design.md`) and the new plan are fine. Anywhere else means a follow-up edit is needed inside this task.

- [ ] **Step 5: Verify the Dockerfile still builds (lint-style smoke test)**

Run:

```bash
docker build -f docker/Dockerfile.agent-workspace --target agent-build -t agenthub-test-agent-build . 2>&1 | tail -20
```

Expected: Stage 1 (agent build) succeeds. (Full image build is slow — we skip it here. The final image gets a real test in Task 16.)

- [ ] **Step 6: Commit**

```bash
git add docker/Dockerfile.agent-workspace
git add -u docker/gh-agenthub-wrapper.sh
git commit -m "docker(workspace): drop preinstalled CLIs and gh wrapper"
```

---

## Task 14: Adjust the MiniMax shim to resolve `claude` from `~/.local/bin`

**Files:**
- Modify: `docker/claude-minimax-wrapper.sh`

- [ ] **Step 1: Edit the shim**

Replace the bottom `exec env …` block (lines 29–39) in `docker/claude-minimax-wrapper.sh` with:

```bash
# Resolve the claude binary. Prefer the per-user install (~/.local/bin)
# because the workspace image no longer bakes claude in; fall back to PATH
# for installs that still have a system-wide one (during rolling upgrades).
CLAUDE_BIN="${HOME}/.local/bin/claude"
if [ ! -x "$CLAUDE_BIN" ]; then
  CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
fi
if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
  cat >&2 <<'EOF'
claude-minimax: Claude Code is not installed in this workspace yet.

Wait a few seconds for the essentials installer to finish (terminal
scrollback will show "[essentials] claude-code installed"), or open the
Packages page and install Claude Code manually.
EOF
  exit 1
fi

exec env \
  ANTHROPIC_BASE_URL="${MINIMAX_BASE_URL:-https://api.minimax.io/anthropic}" \
  ANTHROPIC_AUTH_TOKEN="$MINIMAX_API_KEY" \
  ANTHROPIC_MODEL="MiniMax-M2.7" \
  ANTHROPIC_DEFAULT_SONNET_MODEL="MiniMax-M2.7" \
  ANTHROPIC_DEFAULT_OPUS_MODEL="MiniMax-M2.7" \
  ANTHROPIC_DEFAULT_HAIKU_MODEL="MiniMax-M2.7" \
  ANTHROPIC_SMALL_FAST_MODEL="MiniMax-M2.7" \
  API_TIMEOUT_MS=3000000 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  "$CLAUDE_BIN" --model MiniMax-M2.7 --dangerously-skip-permissions "$@"
```

(The early-exit `if [[ -z "${MINIMAX_API_KEY:-}" ]]` block at the top of the file is unchanged. Keep `set -euo pipefail` and the existing top-of-file comment block.)

- [ ] **Step 2: Shellcheck the result**

Run:

```bash
shellcheck docker/claude-minimax-wrapper.sh
```

Expected: clean (no warnings). If shellcheck isn't installed, skip — CI will catch it.

- [ ] **Step 3: Commit**

```bash
git add docker/claude-minimax-wrapper.sh
git commit -m "docker(claude-minimax): resolve claude from ~/.local/bin"
```

---

## Task 15: Final whole-repo verification

**Files:**
- (none — verification only)

- [ ] **Step 1: Typecheck the whole repo**

Run: `pnpm typecheck`
Expected: PASS — zero errors across all packages.

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`
Expected: PASS — installer, server, and agent suites all green.

- [ ] **Step 3: Run lint where defined**

Run: `pnpm lint`
Expected: PASS (or zero warnings on packages that have lint configured).

- [ ] **Step 4: Confirm no orphan references to removed symbols**

Run:

```bash
rg -n "isBuiltin|preinstalled" packages/server packages/web packages/agent
```

Expected: only the `isBuiltin?: boolean` field declaration in `catalog.ts` remains (we kept it intentionally so future cleanup is a one-line removal once nothing else reads it). Everything else should be gone. Any other hits → fix in a follow-up edit before continuing.

- [ ] **Step 5: Build the web bundle**

Run: `pnpm --filter @agenthub/web build`
Expected: PASS.

- [ ] **Step 6: Commit any final cleanup that surfaced**

If steps 1–5 surfaced any tiny adjustments, commit them:

```bash
git add -p
git commit -m "fix: <whatever the cleanup was>"
```

If nothing surfaced, skip the commit.

---

## Task 16: Manual fresh-VM verification

**Files:**
- (none — manual operator checklist)

> This task is executed on a fresh Debian 12 Proxmox VM cloned from `9000` (per `test_pipeline.md`). It is the canonical pre-PR signal — unit tests cover code, but the install flow + auto-essentials path needs a real environment.

- [ ] **Step 1: Clone a fresh test VM and grab its IP**

In the Proxmox console:

```bash
qm clone 9000 928 --name agenthub-cli-catalog
qm start 928
# wait ~20s for boot
qm guest cmd 928 network-get-interfaces | jq -r '.[] | select(.name=="eth0") | ."ip-addresses"[].\"ip-address\"' | head -1
```

Expected: an IP on the `192.168.4.0/24` subnet. SSH in as `root` with the snapshot's password.

- [ ] **Step 2: One-liner install from the branch**

On the test VM:

```bash
curl -fsSL https://raw.githubusercontent.com/physikal/agenthubv2/feat/cli-catalog-migration/scripts/install.sh | bash
```

Expected: install completes, the stack starts. (If the branch isn't pushed yet, push first: `git push origin feat/cli-catalog-migration`.)

- [ ] **Step 3: Log in to the web UI**

Open `http://<vm-ip>` in a browser. Log in with `admin` / the password printed by the installer.

- [ ] **Step 4: Create a session**

Sessions → New session → confirm the session reaches "active" within ~10s.

- [ ] **Step 5: Open the terminal and watch essentials install**

Terminal tab → expect to see scrollback like:

```
[essentials] installing: claude-code, opencode, codex
[essentials] claude-code installed (1.0.x)
[essentials] opencode installed (0.x.x)
[essentials] codex installed (x.y.z)
```

Within ~30–60 seconds. (Timing varies with network speed.)

- [ ] **Step 6: Verify `claude`, `opencode`, `codex` resolve from `~/.local/bin`**

In the workspace terminal:

```bash
which claude opencode codex
# expected: /home/coder/.local/bin/claude  (etc.)
claude --version
opencode --version
codex --version
```

Expected: each prints a version. `which` should NOT show `/usr/bin/claude` — the image no longer bakes it.

- [ ] **Step 7: Verify gh is the plain apt-installed binary**

```bash
which gh
# expected: /usr/bin/gh
gh auth status
# expected: "not authenticated" (wrapper is gone — this is correct)
```

Connect GitHub CLI via the Integrations page (Integrations → GitHub CLI → Connect → device code flow). After completion:

```bash
gh auth status
# expected: "Logged in to github.com as <user>"
```

- [ ] **Step 8: Verify the Packages page shows version info**

Open Packages page. Expect:
- Three "Essential" tags on Claude Code, OpenCode, Codex.
- Each card shows the installed version next to the name.
- "Last checked X min ago" footnote under the buttons.
- No "Update available" badge (unless an actual update has dropped — unlikely on a fresh install).

- [ ] **Step 9: Simulate an available update**

In the server container:

```bash
docker exec agenthub-agenthub-server-1 sqlite3 /data/agenthub.db \
  "UPDATE package_version_cache SET latest_version='99.0.0' WHERE package_id='claude-code';"
```

Reload the Packages page in the browser. Expect:
- Yellow "Update available — <current> → 99.0.0" badge on the Claude Code card.
- "Update" button (yellow) in place of "Install".

- [ ] **Step 10: Click Update and confirm reinstall**

Click Update on the Claude Code card. Expect:
- State transitions to "Installing…" within a second.
- Within ~30s, settles back to "Installed".
- `claude --version` in the workspace terminal still works (npm overwrote the binary).
- The "Update available" badge persists (because `99.0.0` is still > the real installed version) — that's expected for this manual-poison case; a real poll would correct it.

- [ ] **Step 11: Clean up the fake cache row**

```bash
docker exec agenthub-agenthub-server-1 sqlite3 /data/agenthub.db \
  "DELETE FROM package_version_cache WHERE package_id='claude-code';"
```

Reload the page. Expect the badge to disappear (and reappear with real values after the next poll tick within 30 min).

- [ ] **Step 12: Verify the MiniMax shim**

In the workspace terminal, with a MiniMax API key configured in Integrations:

```bash
claude-minimax --help
```

Expected: prints Claude Code's help, routed through `~/.local/bin/claude` (no "claude not found" error).

- [ ] **Step 13: Destroy the VM**

```bash
qm stop 928 && qm destroy 928
```

- [ ] **Step 14: All clear — open the PR**

Run:

```bash
git push -u origin feat/cli-catalog-migration
gh pr create --base main --title "feat(packages): CLI catalog migration (Phase 1)" --body "$(cat <<'EOF'
Phase 1 of the CLI-freshness roadmap. Spec at `docs/superpowers/specs/2026-05-16-cli-catalog-migration-design.md`.

## Summary
- Workspace image stops baking `claude-code`, `opencode`, `mmx-cli`.
- Three essentials (`claude-code`, `opencode`, `codex`) auto-install into `/home/coder/.local/bin` on every new session.
- 30-min npm-registry poller writes into `package_version_cache`.
- Packages page surfaces "Update available — X → Y" + per-tool Update button.
- `gh-agenthub-wrapper.sh` deleted (superseded by the Integrations Connect flow from PR #90).
- `claude-minimax` shim resolves `claude` from `~/.local/bin` first.

## Test plan
- [ ] Unit suite green (`pnpm test`)
- [ ] Typecheck clean (`pnpm typecheck`)
- [ ] Fresh-VM install completes end-to-end
- [ ] Session-active fires essentials install and finishes in <60s
- [ ] Packages page shows version info + "Last checked" footnote
- [ ] Manual UPDATE in `package_version_cache` surfaces the yellow badge + Update button
- [ ] Clicking Update reinstalls successfully (npm overwrite)
- [ ] `gh auth status` flows through the Integrations Connect path
- [ ] `claude-minimax` works after essentials install completes

## Migration impact
Existing users get one "first session of the day" that takes ~30–60s longer while essentials install. Subsequent sessions are normal speed. Anyone relying on the gh wrapper's auto-token must Connect GitHub CLI in Integrations once.
EOF
)"
```

(`feat/cli-catalog-migration` is the working branch. Adjust if the branch was renamed.)

---

## Spec coverage check

Mapped against `docs/superpowers/specs/2026-05-16-cli-catalog-migration-design.md`:

| Spec section | Task(s) |
|---|---|
| Catalog: `essential` flag + entries adjusted | 1 |
| Catalog: no `isBuiltin: true` | 1 |
| DB: `package_version_cache` table | 2 |
| DB: DDL in `initDb()` | 2 |
| Server: `version-check.ts` (npm + future github-release) | 4 |
| Server: `poller.ts` (30-min tick) | 5 |
| Server: boot poller in `index.ts` | 6 |
| Server: `GET /api/packages` join cache → `latestVersion` / `updateAvailable` / `versionCheckedAt` | 7 |
| Server: semver compare helper | 3 |
| Agent: `essentials.ts` + idempotency | 9 |
| Agent: `packages-protocol.ts` | 8 |
| Agent: `ws-server.ts` routing parallel to auth | 10 |
| SessionManager: `ensureEssentialsForSession` post-active hook | 11 |
| Web: Update-available badge + Update button + Last-checked footnote | 12 |
| Dockerfile: remove `npm install -g …` block | 13 |
| Dockerfile: remove gh-wrapper COPY + chmod | 13 |
| Delete `docker/gh-agenthub-wrapper.sh` | 13 |
| MiniMax shim: resolve `claude` from `~/.local/bin` | 14 |
| Whole-repo verification (typecheck/test/lint) | 15 |
| Fresh-VM manual test + PR | 16 |
| Error handling — npm down, install fail, user-deleted binary, new essential added later, mid-install crash | covered by 9 (idempotency) + 5 (preserves last-good on error) + 11 (re-runs on next session-active) |

All spec sections are mapped to at least one task.
