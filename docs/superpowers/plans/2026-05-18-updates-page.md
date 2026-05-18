# Updates Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an admin-only `/admin/updates` page that surfaces AgentHub binary drift (relocated from Settings) plus container image pin drift (Traefik, Postgres, Redis, Infisical) with per-row apply actions that mutate `compose/.env` and recreate one service at a time.

**Architecture:** New `services/images/` directory paralleling Phase 1's `services/packages/`. SQLite `image_version_cache` table populated by a 30-min poller that hits Docker Hub. Apply endpoint writes env-override + runs `compose pull` + `compose up -d --no-deps <service>` with SSE log streaming and on-failure rollback. Two-section page: extracted `AgentHubPanel` (existing flow unchanged) above a new `ImagePinsTable`.

**Tech Stack:** TypeScript (strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`), Drizzle ORM on better-sqlite3, Hono routes, React 19 + Vite, vitest, Tailwind. Node 22, pnpm 10.12.1.

**Spec:** `docs/superpowers/specs/2026-05-18-updates-page-design.md`

---

## File Structure

**Create (server):**
- `packages/server/src/services/images/types.ts` — `ImageKey`, `ImageCatalogEntry`, request/response types
- `packages/server/src/services/images/catalog.ts` — 4-entry catalog (repo slug, compose service name, env var name, disruption blurb)
- `packages/server/src/services/images/pin-policy.ts` — per-image semver regex, classification, newest-within/across-major selectors
- `packages/server/src/services/images/pin-policy.test.ts`
- `packages/server/src/services/images/registry-client.ts` — Docker Hub tags listing + manifest digest fetcher
- `packages/server/src/services/images/registry-client.test.ts`
- `packages/server/src/services/images/env-overrides.ts` — read pin from `.env` + compose default, atomic upsert writer, backup/restore/prune
- `packages/server/src/services/images/env-overrides.test.ts`
- `packages/server/src/services/images/poller.ts` — `ImagePoller` class mirroring `VersionPoller`
- `packages/server/src/services/images/poller.test.ts`
- `packages/server/src/services/images/manager.ts` — aggregator (`getUpdatesSummary`) + apply orchestrator (`applyImageUpdate`)
- `packages/server/src/services/images/manager.test.ts`
- `packages/server/src/routes/admin-updates.ts` — `GET /api/admin/updates`, `POST /api/admin/updates/refresh`, `POST /api/admin/updates/image`
- `packages/server/src/routes/admin-updates.test.ts`

**Create (web):**
- `packages/web/src/pages/admin/Updates.tsx`
- `packages/web/src/components/updates/AgentHubPanel.tsx` (extracted from `Settings.tsx`)
- `packages/web/src/components/updates/ImagePinsTable.tsx`
- `packages/web/src/components/updates/ImageRowConfirmModal.tsx`

**Modify:**
- `packages/server/src/db/schema.ts` — add `imageVersionCache` table + types
- `packages/server/src/db/index.ts` — add `CREATE TABLE IF NOT EXISTS image_version_cache` to the DDL block
- `packages/server/src/index.ts` — start the `ImagePoller` alongside the existing `VersionPoller`
- `packages/server/src/routes/admin.ts` — export the existing `updateLock` so `admin-updates` can share it (or move it to a shared module)
- `compose/docker-compose.yml` — add `${VAR:-default}` env-override wrappers for the 4 pinned images
- `packages/server/test/compose-pins.test.ts` (new file alongside existing access-mode tests) — assert compose resolves to current defaults when env is empty
- `packages/web/src/App.tsx` — register `/admin/updates` route
- `packages/web/src/components/Sidebar.tsx` — admin-gated nav item for `/admin/updates`
- `packages/web/src/pages/Settings.tsx` — remove `VersionPanel` block and the now-unused supporting types/constants

---

## Task 1: Database schema for `image_version_cache`

**Files:**
- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/db/index.ts`

- [ ] **Step 1: Add Drizzle definition + types**

Append to `packages/server/src/db/schema.ts` (end of file, before the existing `export type PackageVersionCache` block):

```ts
/**
 * Latest-version cache populated by the image-registry poller. One row per
 * logical image (`traefik` | `postgres` | `redis` | `infisical`). Not user-
 * scoped — pin state is install-wide.
 *
 * On every poll tick:
 *   - success: newest* columns set (or upstreamDigest for digest mode),
 *     lastError cleared
 *   - failure: newest* / digest left at last-good, lastError populated
 */
export const imageVersionCache = sqliteTable("image_version_cache", {
  image: text("image").primaryKey(),
  pinnedTag: text("pinned_tag").notNull(),
  newestWithinMajor: text("newest_within_major"),
  newestAcrossMajor: text("newest_across_major"),
  upstreamDigest: text("upstream_digest"),
  lastCheckedAt: integer("last_checked_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastError: text("last_error"),
});
```

Then add to the types block at the bottom of the file (next to `PackageVersionCache`):

```ts
export type ImageVersionCache = typeof imageVersionCache.$inferSelect;
export type NewImageVersionCache = typeof imageVersionCache.$inferInsert;
```

- [ ] **Step 2: Add raw DDL to `db/index.ts`**

Find the existing block ending with the `CREATE TABLE IF NOT EXISTS package_version_cache (...)` statement at `packages/server/src/db/index.ts:207-212`. Append immediately after the closing `);` of that statement, inside the same `db.exec(\`...\`)` template:

```sql
    CREATE TABLE IF NOT EXISTS image_version_cache (
      image TEXT PRIMARY KEY,
      pinned_tag TEXT NOT NULL,
      newest_within_major TEXT,
      newest_across_major TEXT,
      upstream_digest TEXT,
      last_checked_at INTEGER NOT NULL,
      last_error TEXT
    );
```

- [ ] **Step 3: Run typecheck to confirm schema compiles**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/db/schema.ts packages/server/src/db/index.ts
git commit -m "feat(updates): add image_version_cache table"
```

---

## Task 2: Catalog + types

**Files:**
- Create: `packages/server/src/services/images/types.ts`
- Create: `packages/server/src/services/images/catalog.ts`

- [ ] **Step 1: Write `types.ts`**

Create `packages/server/src/services/images/types.ts`:

```ts
export type ImageKey = "traefik" | "postgres" | "redis" | "infisical";

export interface ImageCatalogEntry {
  readonly key: ImageKey;
  readonly displayName: string;
  // Docker Hub repository slug. Single-segment for official images
  // ("traefik"), two-segment for org images ("infisical/infisical").
  readonly repo: string;
  // The compose service name (`docker compose ... <service>`).
  // Note: postgres/redis services are namespaced `infisical-postgres` /
  // `infisical-redis` because they're Infisical's data layer.
  readonly composeService: string;
  // The env var that overrides the pin in compose.yml.
  readonly envVar: string;
  // The default image:tag if no env override is set. MUST match the
  // value baked into compose/docker-compose.yml after Task 6 lands.
  readonly defaultPin: string;
  // Human-readable description of what happens when this service is
  // recreated. Shown in the confirmation modal.
  readonly disruption: string;
}
```

- [ ] **Step 2: Write `catalog.ts`**

Create `packages/server/src/services/images/catalog.ts`:

```ts
import type { ImageCatalogEntry, ImageKey } from "./types.js";

export const CATALOG: Record<ImageKey, ImageCatalogEntry> = {
  traefik: {
    key: "traefik",
    displayName: "Traefik",
    repo: "traefik",
    composeService: "traefik",
    envVar: "TRAEFIK_IMAGE",
    defaultPin: "traefik:v3.6",
    disruption:
      "Restarts the reverse proxy. New HTTP requests fail for 1-2s while Traefik reloads.",
  },
  postgres: {
    key: "postgres",
    displayName: "Postgres (Infisical)",
    repo: "postgres",
    composeService: "infisical-postgres",
    envVar: "POSTGRES_IMAGE",
    defaultPin: "postgres:16-alpine",
    disruption:
      "Restarts Infisical's database. Infisical fails secret reads for 5-15s while postgres restarts; agenthub-server may briefly fail to resolve user secrets.",
  },
  redis: {
    key: "redis",
    displayName: "Redis (Infisical)",
    repo: "redis",
    composeService: "infisical-redis",
    envVar: "REDIS_IMAGE",
    defaultPin: "redis:7-alpine",
    disruption:
      "Restarts Infisical's cache. Infisical session lookups briefly fail; cached state is lost.",
  },
  infisical: {
    key: "infisical",
    displayName: "Infisical",
    repo: "infisical/infisical",
    composeService: "infisical",
    envVar: "INFISICAL_IMAGE",
    defaultPin: "infisical/infisical:latest-postgres",
    disruption:
      "Restarts the Infisical server. Secret reads fail for ~10s; existing sessions remain.",
  },
};

export const CATALOG_KEYS: readonly ImageKey[] = [
  "traefik",
  "postgres",
  "redis",
  "infisical",
];
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/services/images/types.ts packages/server/src/services/images/catalog.ts
git commit -m "feat(updates): image catalog + types"
```

---

## Task 3: Pin policy (TDD)

**Files:**
- Create: `packages/server/src/services/images/pin-policy.ts`
- Test: `packages/server/src/services/images/pin-policy.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/services/images/pin-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  PIN_POLICY,
  classify,
  newestWithinMajor,
  newestAcrossMajor,
  parsePinnedRef,
} from "./pin-policy.js";

describe("classify", () => {
  it("parses traefik semver tags", () => {
    expect(classify("v3.6", PIN_POLICY.traefik)).toMatchObject({ major: 3, minor: 6, patch: 0 });
    expect(classify("v3.7.1", PIN_POLICY.traefik)).toMatchObject({ major: 3, minor: 7, patch: 1 });
    expect(classify("v4.0", PIN_POLICY.traefik)).toMatchObject({ major: 4 });
  });

  it("rejects non-matching traefik tags", () => {
    expect(classify("latest", PIN_POLICY.traefik)).toBe("unknown");
    expect(classify("v3.6.4-rc1", PIN_POLICY.traefik)).toBe("unknown");
    expect(classify("3.6", PIN_POLICY.traefik)).toBe("unknown");
  });

  it("parses postgres alpine + non-alpine tags, preserving variant", () => {
    expect(classify("16-alpine", PIN_POLICY.postgres)).toMatchObject({
      major: 16, minor: 0, patch: 0, variant: "-alpine",
    });
    expect(classify("16.4-alpine", PIN_POLICY.postgres)).toMatchObject({
      major: 16, minor: 4, patch: 0, variant: "-alpine",
    });
    expect(classify("16.4.1", PIN_POLICY.postgres)).toMatchObject({
      major: 16, minor: 4, patch: 1, variant: undefined,
    });
  });
});

describe("newestWithinMajor", () => {
  it("returns the newest tag within the requested major + matching variant", () => {
    const tags = [
      classify("16-alpine", PIN_POLICY.postgres),
      classify("16.2-alpine", PIN_POLICY.postgres),
      classify("16.4-alpine", PIN_POLICY.postgres),
      classify("16.4", PIN_POLICY.postgres),  // wrong variant
      classify("17-alpine", PIN_POLICY.postgres),  // wrong major
    ].filter((p) => p !== "unknown");
    const result = newestWithinMajor(tags, 16, "-alpine");
    expect(result?.raw).toBe("16.4-alpine");
  });

  it("returns null when no in-major tags newer than the pinned tag exist", () => {
    const tags = [classify("v3.6", PIN_POLICY.traefik)].filter((p) => p !== "unknown");
    expect(newestWithinMajor(tags, 3, undefined, classify("v3.6", PIN_POLICY.traefik))).toBeNull();
  });
});

describe("newestAcrossMajor", () => {
  it("returns the newest tag with major > pinnedMajor", () => {
    const tags = [
      classify("v3.6", PIN_POLICY.traefik),
      classify("v3.7.1", PIN_POLICY.traefik),
      classify("v4.0", PIN_POLICY.traefik),
      classify("v4.1.2", PIN_POLICY.traefik),
    ].filter((p) => p !== "unknown");
    const result = newestAcrossMajor(tags, 3);
    expect(result?.raw).toBe("v4.1.2");
  });

  it("returns null when no higher major exists", () => {
    const tags = [classify("v3.6", PIN_POLICY.traefik), classify("v3.7", PIN_POLICY.traefik)]
      .filter((p) => p !== "unknown");
    expect(newestAcrossMajor(tags, 3)).toBeNull();
  });
});

describe("parsePinnedRef", () => {
  it("splits image:tag", () => {
    expect(parsePinnedRef("traefik:v3.6")).toEqual({ image: "traefik", tag: "v3.6" });
    expect(parsePinnedRef("infisical/infisical:latest-postgres")).toEqual({
      image: "infisical/infisical", tag: "latest-postgres",
    });
  });

  it("defaults to 'latest' when no tag", () => {
    expect(parsePinnedRef("traefik")).toEqual({ image: "traefik", tag: "latest" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/images/pin-policy.test.ts`
Expected: FAIL with "Cannot find module './pin-policy.js'".

- [ ] **Step 3: Write `pin-policy.ts`**

Create `packages/server/src/services/images/pin-policy.ts`:

```ts
import type { ImageKey } from "./types.js";

export interface SemverParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
  readonly variant: string | undefined;
}

export type PinPolicy =
  | {
      readonly mode: "semver";
      readonly matcher: RegExp;
      readonly extract: (m: RegExpMatchArray) => SemverParts;
    }
  | { readonly mode: "digest" };

const traefikMatcher = /^v(\d+)\.(\d+)(?:\.(\d+))?$/;
const pgRedisMatcher = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(-alpine)?$/;

export const PIN_POLICY: Record<ImageKey, PinPolicy> = {
  traefik: {
    mode: "semver",
    matcher: traefikMatcher,
    extract: (m) => ({
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: m[3] ? Number(m[3]) : 0,
      raw: m[0],
      variant: undefined,
    }),
  },
  postgres: {
    mode: "semver",
    matcher: pgRedisMatcher,
    extract: (m) => ({
      major: Number(m[1]),
      minor: m[2] ? Number(m[2]) : 0,
      patch: m[3] ? Number(m[3]) : 0,
      raw: m[0],
      variant: m[4] ?? undefined,
    }),
  },
  redis: {
    mode: "semver",
    matcher: pgRedisMatcher,
    extract: (m) => ({
      major: Number(m[1]),
      minor: m[2] ? Number(m[2]) : 0,
      patch: m[3] ? Number(m[3]) : 0,
      raw: m[0],
      variant: m[4] ?? undefined,
    }),
  },
  infisical: { mode: "digest" },
};

/** Returns `'unknown'` if the tag doesn't match the policy regex. */
export function classify(tag: string, policy: PinPolicy): SemverParts | "unknown" {
  if (policy.mode === "digest") return "unknown";
  const m = tag.match(policy.matcher);
  if (!m) return "unknown";
  return policy.extract(m);
}

function cmp(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Newest tag within the pinned major, preserving variant stickiness.
 * If `pinned` is provided, the result must be strictly newer than it.
 */
export function newestWithinMajor(
  tags: readonly SemverParts[],
  pinnedMajor: number,
  variant: string | undefined,
  pinned?: SemverParts,
): SemverParts | null {
  const inMajor = tags.filter((t) => t.major === pinnedMajor && t.variant === variant);
  if (inMajor.length === 0) return null;
  const newest = inMajor.reduce((best, cur) => (cmp(cur, best) > 0 ? cur : best));
  if (pinned && cmp(newest, pinned) <= 0) return null;
  return newest;
}

export function newestAcrossMajor(
  tags: readonly SemverParts[],
  pinnedMajor: number,
): SemverParts | null {
  const above = tags.filter((t) => t.major > pinnedMajor);
  if (above.length === 0) return null;
  return above.reduce((best, cur) => (cmp(cur, best) > 0 ? cur : best));
}

export function parsePinnedRef(ref: string): { readonly image: string; readonly tag: string } {
  const idx = ref.lastIndexOf(":");
  // Guard against scheme-looking strings; only treat the last `:`-segment as
  // a tag if it doesn't contain `/` (registry hosts use `host:port/image`).
  if (idx === -1 || ref.slice(idx).includes("/")) {
    return { image: ref, tag: "latest" };
  }
  return { image: ref.slice(0, idx), tag: ref.slice(idx + 1) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/images/pin-policy.test.ts`
Expected: PASS, all assertions green.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/images/pin-policy.ts packages/server/src/services/images/pin-policy.test.ts
git commit -m "feat(updates): pin policy classifier + selectors"
```

---

## Task 4: Registry client (TDD)

**Files:**
- Create: `packages/server/src/services/images/registry-client.ts`
- Test: `packages/server/src/services/images/registry-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/services/images/registry-client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerHubClient } from "./registry-client.js";

describe("DockerHubClient.listTags", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("paginates and returns flat tag names", async () => {
    const pages = [
      { results: [{ name: "v3.6" }, { name: "v3.7" }], next: "page2" },
      { results: [{ name: "v3.7.1" }, { name: "v3.7.2" }], next: null },
    ];
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      const body = pages[call++];
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    const client = new DockerHubClient();
    const tags = await client.listTags("traefik", 5);
    expect(tags).toEqual(["v3.6", "v3.7", "v3.7.1", "v3.7.2"]);
  });

  it("stops at maxPages even if next cursor is non-null", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ name: "x" }], next: "more" }), { status: 200 }),
    ) as typeof fetch;
    const client = new DockerHubClient();
    const tags = await client.listTags("traefik", 2);
    expect(tags).toHaveLength(2);
  });

  it("throws on 5xx", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 503 })) as typeof fetch;
    const client = new DockerHubClient();
    await expect(client.listTags("traefik", 1)).rejects.toThrow(/503/);
  });
});

describe("DockerHubClient.getDigest", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("returns Docker-Content-Digest header value", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://auth.docker.io/token")) {
        return new Response(JSON.stringify({ token: "abc" }), { status: 200 });
      }
      return new Response("", {
        status: 200,
        headers: { "Docker-Content-Digest": "sha256:cafef00d" },
      });
    }) as typeof fetch;

    const client = new DockerHubClient();
    const digest = await client.getDigest("infisical/infisical", "latest-postgres");
    expect(digest).toBe("sha256:cafef00d");
  });

  it("throws when manifest endpoint returns 4xx", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://auth.docker.io/token")) {
        return new Response(JSON.stringify({ token: "abc" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const client = new DockerHubClient();
    await expect(client.getDigest("foo/bar", "nonexistent")).rejects.toThrow(/404/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/images/registry-client.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Write `registry-client.ts`**

Create `packages/server/src/services/images/registry-client.ts`:

```ts
interface TagsResponse {
  readonly results: ReadonlyArray<{ readonly name: string }>;
  readonly next: string | null;
}

interface TokenResponse {
  readonly token: string;
}

export interface RegistryClient {
  listTags(repo: string, maxPages: number): Promise<readonly string[]>;
  getDigest(repo: string, tag: string): Promise<string>;
}

export class DockerHubClient implements RegistryClient {
  async listTags(repo: string, maxPages: number): Promise<readonly string[]> {
    const out: string[] = [];
    let url: string | null =
      `https://hub.docker.com/v2/repositories/${encodeURI(repo)}/tags?page_size=100`;
    let pages = 0;
    while (url && pages < maxPages) {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`docker hub listTags(${repo}) failed: ${String(res.status)}`);
      }
      const body = (await res.json()) as TagsResponse;
      for (const r of body.results) out.push(r.name);
      url = body.next;
      pages += 1;
    }
    return out;
  }

  async getDigest(repo: string, tag: string): Promise<string> {
    const tokenUrl =
      `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${encodeURI(repo)}:pull`;
    const tokenRes = await fetch(tokenUrl);
    if (!tokenRes.ok) {
      throw new Error(`docker hub auth failed: ${String(tokenRes.status)}`);
    }
    const tokenBody = (await tokenRes.json()) as TokenResponse;
    const manifestUrl = `https://registry-1.docker.io/v2/${encodeURI(repo)}/manifests/${encodeURIComponent(tag)}`;
    const res = await fetch(manifestUrl, {
      headers: {
        authorization: `Bearer ${tokenBody.token}`,
        accept: "application/vnd.docker.distribution.manifest.v2+json",
      },
    });
    if (!res.ok) {
      throw new Error(`docker hub getDigest(${repo}:${tag}) failed: ${String(res.status)}`);
    }
    const digest = res.headers.get("Docker-Content-Digest");
    if (!digest) throw new Error(`docker hub getDigest(${repo}:${tag}) missing digest header`);
    return digest;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/images/registry-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/images/registry-client.ts packages/server/src/services/images/registry-client.test.ts
git commit -m "feat(updates): Docker Hub registry client"
```

---

## Task 5: Env-overrides module (TDD)

**Files:**
- Create: `packages/server/src/services/images/env-overrides.ts`
- Test: `packages/server/src/services/images/env-overrides.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/services/images/env-overrides.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EnvOverrides,
} from "./env-overrides.js";

describe("EnvOverrides", () => {
  let dir: string;
  let env: EnvOverrides;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "envov-"));
    writeFileSync(join(dir, ".env"), "FOO=bar\n# comment\nBAZ=qux\n");
    env = new EnvOverrides({ envPath: join(dir, ".env") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("readPin returns the override when set, falling back to the default", () => {
    writeFileSync(join(dir, ".env"), "TRAEFIK_IMAGE=traefik:v3.7\n");
    expect(env.readPin("traefik")).toBe("traefik:v3.7");
    // Postgres has no override → falls back to catalog default
    expect(env.readPin("postgres")).toBe("postgres:16-alpine");
  });

  it("writePin upserts in place, preserves other keys + comments + trailing newline", () => {
    env.writePin("traefik", "traefik:v3.7.1");
    const after = readFileSync(join(dir, ".env"), "utf8");
    expect(after).toContain("FOO=bar");
    expect(after).toContain("# comment");
    expect(after).toContain("BAZ=qux");
    expect(after).toContain("TRAEFIK_IMAGE=traefik:v3.7.1");
    expect(after.endsWith("\n")).toBe(true);
  });

  it("writePin replaces an existing override line without duplicating it", () => {
    writeFileSync(join(dir, ".env"), "TRAEFIK_IMAGE=traefik:v3.6\nFOO=bar\n");
    env.writePin("traefik", "traefik:v3.7.1");
    const after = readFileSync(join(dir, ".env"), "utf8");
    const matches = after.match(/^TRAEFIK_IMAGE=/gm) ?? [];
    expect(matches).toHaveLength(1);
    expect(after).toContain("TRAEFIK_IMAGE=traefik:v3.7.1");
    expect(after).toContain("FOO=bar");
  });

  it("backupEnv creates a timestamped copy", () => {
    const backupPath = env.backupEnv();
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, "utf8")).toBe(readFileSync(join(dir, ".env"), "utf8"));
  });

  it("restoreEnv reverts to the backup contents", () => {
    const backupPath = env.backupEnv();
    writeFileSync(join(dir, ".env"), "BROKEN=true\n");
    env.restoreEnv(backupPath);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("FOO=bar\n# comment\nBAZ=qux\n");
  });

  it("pruneOldBackups keeps the N newest", () => {
    // Create 5 backups with deliberate name ordering
    env.backupEnv();
    env.backupEnv();
    env.backupEnv();
    env.backupEnv();
    env.backupEnv();
    env.pruneOldBackups(2);
    const remaining = readdirSync(dir).filter((f) => f.startsWith(".env.bak-"));
    expect(remaining).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/images/env-overrides.test.ts`
Expected: FAIL (module-not-found).

- [ ] **Step 3: Write `env-overrides.ts`**

Create `packages/server/src/services/images/env-overrides.ts`:

```ts
import {
  copyFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { CATALOG } from "./catalog.js";
import type { ImageKey } from "./types.js";

interface EnvOverridesConfig {
  readonly envPath: string;
}

export class EnvOverrides {
  private readonly envPath: string;
  private readonly envDir: string;
  private readonly envBase: string;

  constructor(cfg: EnvOverridesConfig) {
    this.envPath = cfg.envPath;
    this.envDir = dirname(cfg.envPath);
    this.envBase = basename(cfg.envPath);
  }

  /** Returns the current pin for an image: env override if present, else catalog default. */
  readPin(image: ImageKey): string {
    const entry = CATALOG[image];
    const env = this.readEnvMap();
    return env.get(entry.envVar) ?? entry.defaultPin;
  }

  /**
   * Atomic upsert of the env-var line for one image. Writes to a sibling
   * `.tmp` file then renames into place so a crash mid-write can't leave
   * a half-written .env.
   */
  writePin(image: ImageKey, fullImageRef: string): void {
    const entry = CATALOG[image];
    const lines = this.readLines();
    const key = entry.envVar;
    let replaced = false;
    const next = lines.map((line) => {
      if (line.startsWith(`${key}=`)) {
        replaced = true;
        return `${key}=${fullImageRef}`;
      }
      return line;
    });
    if (!replaced) next.push(`${key}=${fullImageRef}`);
    const tmp = `${this.envPath}.tmp`;
    writeFileSync(tmp, `${next.join("\n")}\n`, { mode: 0o600 });
    renameSync(tmp, this.envPath);
  }

  backupEnv(): string {
    // ISO with `:` replaced — colons aren't valid in some filesystems and
    // are awkward in shell globs.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(this.envDir, `${this.envBase}.bak-${stamp}`);
    copyFileSync(this.envPath, path);
    return path;
  }

  restoreEnv(backupPath: string): void {
    copyFileSync(backupPath, this.envPath);
  }

  pruneOldBackups(keep: number): void {
    const prefix = `${this.envBase}.bak-`;
    const candidates = readdirSync(this.envDir)
      .filter((f) => f.startsWith(prefix))
      .sort();  // ISO timestamps sort lexicographically
    const toDelete = candidates.slice(0, Math.max(0, candidates.length - keep));
    for (const f of toDelete) unlinkSync(join(this.envDir, f));
  }

  private readLines(): string[] {
    const raw = readFileSync(this.envPath, "utf8");
    // Drop the trailing empty string if file ends in newline
    const lines = raw.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  private readEnvMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const line of this.readLines()) {
      if (line.startsWith("#") || line.trim() === "") continue;
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      map.set(line.slice(0, idx), line.slice(idx + 1));
    }
    return map;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/images/env-overrides.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/images/env-overrides.ts packages/server/src/services/images/env-overrides.test.ts
git commit -m "feat(updates): env-override reader + atomic writer"
```

---

## Task 6: Compose.yml env-override refactor

**Files:**
- Modify: `compose/docker-compose.yml`
- Create: `packages/server/test/compose-pins.test.ts`

- [ ] **Step 1: Refactor compose.yml — wrap 4 image lines**

In `compose/docker-compose.yml`, replace the four image pin lines:

| Line | Old | New |
|---|---|---|
| `traefik:` block | `image: traefik:v3.6` | `image: ${TRAEFIK_IMAGE:-traefik:v3.6}` |
| `infisical-postgres:` block | `image: postgres:16-alpine` | `image: ${POSTGRES_IMAGE:-postgres:16-alpine}` |
| `infisical-redis:` block | `image: redis:7-alpine` | `image: ${REDIS_IMAGE:-redis:7-alpine}` |
| `infisical:` block | `image: infisical/infisical:latest-postgres` | `image: ${INFISICAL_IMAGE:-infisical/infisical:latest-postgres}` |

Use the Edit tool to make each change individually, not a bulk replace — the indentation differs slightly between the four service blocks.

- [ ] **Step 2: Write a guard test that the defaults resolve correctly**

Create `packages/server/test/compose-pins.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const composePath = resolve(__dirname, "../../../compose/docker-compose.yml");

interface ExpectedPin {
  readonly varName: string;
  readonly defaultValue: string;
}

const PINS: readonly ExpectedPin[] = [
  { varName: "TRAEFIK_IMAGE", defaultValue: "traefik:v3.6" },
  { varName: "POSTGRES_IMAGE", defaultValue: "postgres:16-alpine" },
  { varName: "REDIS_IMAGE", defaultValue: "redis:7-alpine" },
  { varName: "INFISICAL_IMAGE", defaultValue: "infisical/infisical:latest-postgres" },
];

describe("compose pin env-overrides", () => {
  it("every pinned image uses ${VAR:-default} interpolation", () => {
    const compose = readFileSync(composePath, "utf8");
    for (const pin of PINS) {
      const needle = `image: \${${pin.varName}:-${pin.defaultValue}}`;
      expect(compose).toContain(needle);
    }
  });

  it("defaults match the catalog's defaultPin values", async () => {
    const { CATALOG } = await import("../src/services/images/catalog.js");
    expect(CATALOG.traefik.defaultPin).toBe("traefik:v3.6");
    expect(CATALOG.postgres.defaultPin).toBe("postgres:16-alpine");
    expect(CATALOG.redis.defaultPin).toBe("redis:7-alpine");
    expect(CATALOG.infisical.defaultPin).toBe("infisical/infisical:latest-postgres");
  });
});
```

- [ ] **Step 3: Run the guard test**

Run: `pnpm --filter @agenthub/server exec vitest run test/compose-pins.test.ts`
Expected: PASS.

- [ ] **Step 4: Run the full server test suite to confirm no regression**

Run: `pnpm --filter @agenthub/server test`
Expected: all green (existing tests + 4 new test files from Tasks 3-5 + this one).

- [ ] **Step 5: Commit**

```bash
git add compose/docker-compose.yml packages/server/test/compose-pins.test.ts
git commit -m "feat(updates): env-overridable compose image pins"
```

---

## Task 7: Image poller (TDD)

**Files:**
- Create: `packages/server/src/services/images/poller.ts`
- Test: `packages/server/src/services/images/poller.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/services/images/poller.test.ts`:

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { db, schema, initDb } from "../../db/index.js";
import { ImagePoller } from "./poller.js";
import { EnvOverrides } from "./env-overrides.js";
import type { RegistryClient } from "./registry-client.js";

beforeAll(() => { initDb(); });

class FakeRegistry implements RegistryClient {
  constructor(
    private readonly tagsByRepo: Record<string, readonly string[]>,
    private readonly digestByTag: Record<string, string> = {},
    private readonly errorRepos: ReadonlySet<string> = new Set(),
  ) {}
  async listTags(repo: string): Promise<readonly string[]> {
    if (this.errorRepos.has(repo)) throw new Error(`forced failure for ${repo}`);
    return this.tagsByRepo[repo] ?? [];
  }
  async getDigest(repo: string, tag: string): Promise<string> {
    if (this.errorRepos.has(repo)) throw new Error(`forced failure for ${repo}`);
    return this.digestByTag[`${repo}:${tag}`] ?? "sha256:deadbeef";
  }
}

describe("ImagePoller.tick", () => {
  let dir: string;
  let env: EnvOverrides;

  beforeEach(() => {
    db.delete(schema.imageVersionCache).run();
    dir = mkdtempSync(join(tmpdir(), "imgpoll-"));
    writeFileSync(join(dir, ".env"), "");
    env = new EnvOverrides({ envPath: join(dir, ".env") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("upserts a row per image with newest within/across major filled in", async () => {
    const registry = new FakeRegistry({
      traefik: ["v3.6", "v3.7.1", "v3.7.2", "v4.0.0"],
      postgres: ["16-alpine", "16.4-alpine", "17-alpine"],
      redis: ["7-alpine", "7.2-alpine", "8-alpine"],
      "infisical/infisical": [],
    }, { "infisical/infisical:latest-postgres": "sha256:abc123" });

    const poller = new ImagePoller(env, registry);
    await poller.tick();

    const rows = db.select().from(schema.imageVersionCache).all();
    expect(rows.map((r) => r.image).sort()).toEqual(["infisical", "postgres", "redis", "traefik"]);
    const traefik = rows.find((r) => r.image === "traefik");
    expect(traefik?.newestWithinMajor).toBe("v3.7.2");
    expect(traefik?.newestAcrossMajor).toBe("v4.0.0");
    expect(traefik?.lastError).toBeNull();
    const pg = rows.find((r) => r.image === "postgres");
    expect(pg?.newestWithinMajor).toBe("16.4-alpine");
    expect(pg?.newestAcrossMajor).toBe("17-alpine");
    const inf = rows.find((r) => r.image === "infisical");
    expect(inf?.upstreamDigest).toBe("sha256:abc123");
    expect(inf?.newestWithinMajor).toBeNull();
  });

  it("isolates per-image failures — one failing image doesn't poison the others", async () => {
    const registry = new FakeRegistry(
      { traefik: ["v3.7"], postgres: ["16-alpine"], redis: ["7-alpine"], "infisical/infisical": [] },
      { "infisical/infisical:latest-postgres": "sha256:xyz" },
      new Set(["traefik"]),
    );
    const poller = new ImagePoller(env, registry);
    await poller.tick();
    const rows = db.select().from(schema.imageVersionCache).all();
    const traefik = rows.find((r) => r.image === "traefik");
    expect(traefik?.lastError).toContain("forced failure");
    const pg = rows.find((r) => r.image === "postgres");
    expect(pg?.lastError).toBeNull();
  });

  it("clears lastError on a subsequent successful tick", async () => {
    const failing = new FakeRegistry(
      { traefik: [], postgres: [], redis: [], "infisical/infisical": [] },
      {},
      new Set(["traefik"]),
    );
    await new ImagePoller(env, failing).tick();
    let traefik = db.select().from(schema.imageVersionCache).all().find((r) => r.image === "traefik");
    expect(traefik?.lastError).toBeTruthy();

    const succeeding = new FakeRegistry(
      { traefik: ["v3.6", "v3.7"], postgres: [], redis: [], "infisical/infisical": [] },
      { "infisical/infisical:latest-postgres": "sha256:x" },
    );
    await new ImagePoller(env, succeeding).tick();
    traefik = db.select().from(schema.imageVersionCache).all().find((r) => r.image === "traefik");
    expect(traefik?.lastError).toBeNull();
    expect(traefik?.newestWithinMajor).toBe("v3.7");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/images/poller.test.ts`
Expected: FAIL (module-not-found).

- [ ] **Step 3: Write `poller.ts`**

Create `packages/server/src/services/images/poller.ts`:

```ts
import { db, schema } from "../../db/index.js";
import { CATALOG, CATALOG_KEYS } from "./catalog.js";
import { EnvOverrides } from "./env-overrides.js";
import {
  PIN_POLICY,
  classify,
  newestAcrossMajor,
  newestWithinMajor,
  parsePinnedRef,
} from "./pin-policy.js";
import type { RegistryClient } from "./registry-client.js";
import type { SemverParts } from "./pin-policy.js";
import type { ImageKey } from "./types.js";

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const JITTER_MS = 2 * 60 * 1000;
const MAX_PAGES = 5;

export class ImagePoller {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly env: EnvOverrides,
    private readonly registry: RegistryClient,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
  ) {}

  start(): void {
    void this.tick();
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    for (const image of CATALOG_KEYS) {
      try {
        await this.tickOne(image);
      } catch (err) {
        this.upsertError(image, err);
      }
    }
  }

  private scheduleNext(): void {
    const jitter = (Math.random() * 2 - 1) * JITTER_MS;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext());
    }, this.intervalMs + jitter);
    this.timer.unref();
  }

  private async tickOne(image: ImageKey): Promise<void> {
    const entry = CATALOG[image];
    const pinnedRef = this.env.readPin(image);
    const { tag: pinnedTag } = parsePinnedRef(pinnedRef);
    const policy = PIN_POLICY[image];

    if (policy.mode === "digest") {
      const digest = await this.registry.getDigest(entry.repo, pinnedTag);
      this.upsertRow({
        image, pinnedTag: pinnedRef,
        newestWithinMajor: null, newestAcrossMajor: null,
        upstreamDigest: digest,
      });
      return;
    }

    const tags = await this.registry.listTags(entry.repo, MAX_PAGES);
    const parsed: SemverParts[] = [];
    for (const t of tags) {
      const r = classify(t, policy);
      if (r !== "unknown") parsed.push(r);
    }
    const pinnedParts = classify(pinnedTag, policy);
    if (pinnedParts === "unknown") {
      this.upsertRow({
        image, pinnedTag: pinnedRef,
        newestWithinMajor: null, newestAcrossMajor: null, upstreamDigest: null,
      });
      return;
    }
    this.upsertRow({
      image, pinnedTag: pinnedRef,
      newestWithinMajor: newestWithinMajor(parsed, pinnedParts.major, pinnedParts.variant, pinnedParts)?.raw ?? null,
      newestAcrossMajor: newestAcrossMajor(parsed, pinnedParts.major)?.raw ?? null,
      upstreamDigest: null,
    });
  }

  private upsertRow(row: {
    image: ImageKey;
    pinnedTag: string;
    newestWithinMajor: string | null;
    newestAcrossMajor: string | null;
    upstreamDigest: string | null;
  }): void {
    const now = new Date();
    db.insert(schema.imageVersionCache)
      .values({
        image: row.image,
        pinnedTag: row.pinnedTag,
        newestWithinMajor: row.newestWithinMajor,
        newestAcrossMajor: row.newestAcrossMajor,
        upstreamDigest: row.upstreamDigest,
        lastCheckedAt: now,
        lastError: null,
      })
      .onConflictDoUpdate({
        target: schema.imageVersionCache.image,
        set: {
          pinnedTag: row.pinnedTag,
          newestWithinMajor: row.newestWithinMajor,
          newestAcrossMajor: row.newestAcrossMajor,
          upstreamDigest: row.upstreamDigest,
          lastCheckedAt: now,
          lastError: null,
        },
      })
      .run();
  }

  private upsertError(image: ImageKey, err: unknown): void {
    const now = new Date();
    const msg = err instanceof Error ? err.message : String(err);
    db.insert(schema.imageVersionCache)
      .values({
        image,
        pinnedTag: this.env.readPin(image),
        newestWithinMajor: null,
        newestAcrossMajor: null,
        upstreamDigest: null,
        lastCheckedAt: now,
        lastError: msg,
      })
      .onConflictDoUpdate({
        target: schema.imageVersionCache.image,
        set: { lastCheckedAt: now, lastError: msg },
      })
      .run();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/images/poller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/images/poller.ts packages/server/src/services/images/poller.test.ts
git commit -m "feat(updates): scheduled image-registry poller"
```

---

## Task 8: Manager (aggregator + apply orchestrator)

**Files:**
- Create: `packages/server/src/services/images/manager.ts`
- Test: `packages/server/src/services/images/manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/services/images/manager.test.ts`:

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { db, schema, initDb } from "../../db/index.js";
import { ImagesManager } from "./manager.js";
import { EnvOverrides } from "./env-overrides.js";

beforeAll(() => { initDb(); });

describe("ImagesManager.getUpdatesSummary", () => {
  let dir: string;
  let env: EnvOverrides;

  beforeEach(() => {
    db.delete(schema.imageVersionCache).run();
    dir = mkdtempSync(join(tmpdir(), "imgmgr-"));
    writeFileSync(join(dir, ".env"), "");
    env = new EnvOverrides({ envPath: join(dir, ".env") });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns one row per catalog image, marking updateAvailable", async () => {
    db.insert(schema.imageVersionCache).values({
      image: "traefik", pinnedTag: "traefik:v3.6",
      newestWithinMajor: "v3.7.1", newestAcrossMajor: "v4.0",
      upstreamDigest: null, lastCheckedAt: new Date(), lastError: null,
    }).run();
    const mgr = new ImagesManager(env, () => Promise.resolve("sha256:current"));
    const summary = await mgr.getUpdatesSummary();
    expect(summary.images).toHaveLength(4);
    const traefik = summary.images.find((r) => r.image === "traefik");
    expect(traefik?.updateAvailable).toBe(true);
    expect(traefik?.newestWithinMajor).toBe("v3.7.1");
    expect(traefik?.newestAcrossMajor).toBe("v4.0");
    // Images without a cache row yet still appear, with null upstream fields
    const pg = summary.images.find((r) => r.image === "postgres");
    expect(pg?.updateAvailable).toBe(false);
    expect(pg?.newestWithinMajor).toBeNull();
  });
});

describe("ImagesManager.validateApply", () => {
  let env: EnvOverrides;
  let dir: string;
  beforeEach(() => {
    db.delete(schema.imageVersionCache).run();
    dir = mkdtempSync(join(tmpdir(), "imgmgr-"));
    writeFileSync(join(dir, ".env"), "");
    env = new EnvOverrides({ envPath: join(dir, ".env") });
    db.insert(schema.imageVersionCache).values({
      image: "traefik", pinnedTag: "traefik:v3.6",
      newestWithinMajor: "v3.7.1", newestAcrossMajor: "v4.0",
      upstreamDigest: null, lastCheckedAt: new Date(), lastError: null,
    }).run();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("accepts a within-major tag", () => {
    const mgr = new ImagesManager(env, () => Promise.resolve(""));
    expect(() => mgr.validateApply({ image: "traefik", tag: "v3.7.1" })).not.toThrow();
  });

  it("rejects major bump without acknowledgedMajor", () => {
    const mgr = new ImagesManager(env, () => Promise.resolve(""));
    expect(() => mgr.validateApply({ image: "traefik", tag: "v4.0" }))
      .toThrow(/acknowledgedMajor/);
  });

  it("accepts major bump with acknowledgedMajor", () => {
    const mgr = new ImagesManager(env, () => Promise.resolve(""));
    expect(() => mgr.validateApply({ image: "traefik", tag: "v4.0", acknowledgedMajor: true }))
      .not.toThrow();
  });

  it("rejects an arbitrary tag not in the cache", () => {
    const mgr = new ImagesManager(env, () => Promise.resolve(""));
    expect(() => mgr.validateApply({ image: "traefik", tag: "v9.9.9" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/images/manager.test.ts`
Expected: FAIL (module-not-found).

- [ ] **Step 3: Write `manager.ts`**

Create `packages/server/src/services/images/manager.ts`:

```ts
import { spawn } from "node:child_process";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";
import { CATALOG, CATALOG_KEYS } from "./catalog.js";
import type { EnvOverrides } from "./env-overrides.js";
import type { ImageKey } from "./types.js";

export interface ImageRowSummary {
  readonly image: ImageKey;
  readonly displayName: string;
  readonly pinnedTag: string;
  readonly newestWithinMajor: string | null;
  readonly newestAcrossMajor: string | null;
  readonly upstreamDigest: string | null;
  readonly runningDigest: string | null;
  readonly updateAvailable: boolean;
  readonly lastCheckedAt: string | null;
  readonly lastError: string | null;
  readonly disruption: string;
}

export interface UpdatesSummary {
  readonly images: readonly ImageRowSummary[];
}

export type ApplyRequest =
  | { readonly image: ImageKey; readonly tag: string; readonly acknowledgedMajor?: boolean }
  | { readonly image: "infisical"; readonly digestUpdate: true };

export type ApplyEvent =
  | { readonly kind: "phase"; readonly phase: ApplyPhase }
  | { readonly kind: "log"; readonly line: string }
  | { readonly kind: "error"; readonly message: string };

export type ApplyPhase =
  | "validating"
  | "writing-env"
  | "pulling"
  | "recreating"
  | "done"
  | "failed";

export type RunningDigestResolver = (composeService: string) => Promise<string | null>;

const COMPOSE_PATH = process.env.COMPOSE_FILE ?? "compose/docker-compose.yml";

export class ImagesManager {
  constructor(
    private readonly env: EnvOverrides,
    private readonly runningDigest: RunningDigestResolver,
  ) {}

  async getUpdatesSummary(): Promise<UpdatesSummary> {
    const rowsByKey = new Map(
      db.select().from(schema.imageVersionCache).all().map((r) => [r.image, r]),
    );
    const images: ImageRowSummary[] = [];
    for (const key of CATALOG_KEYS) {
      const entry = CATALOG[key];
      const row = rowsByKey.get(key);
      const pinnedTag = this.env.readPin(key);
      const newestWithinMajor = row?.newestWithinMajor ?? null;
      const newestAcrossMajor = row?.newestAcrossMajor ?? null;
      const upstreamDigest = row?.upstreamDigest ?? null;
      const runningDigest = upstreamDigest ? await this.runningDigest(entry.composeService) : null;
      const updateAvailable =
        Boolean(newestWithinMajor) ||
        Boolean(newestAcrossMajor) ||
        Boolean(upstreamDigest && runningDigest && upstreamDigest !== runningDigest);
      images.push({
        image: key,
        displayName: entry.displayName,
        pinnedTag,
        newestWithinMajor,
        newestAcrossMajor,
        upstreamDigest,
        runningDigest,
        updateAvailable,
        lastCheckedAt: row?.lastCheckedAt?.toISOString() ?? null,
        lastError: row?.lastError ?? null,
        disruption: entry.disruption,
      });
    }
    return { images };
  }

  validateApply(req: ApplyRequest): void {
    if ("digestUpdate" in req) {
      const cached = db.select().from(schema.imageVersionCache)
        .where(eq(schema.imageVersionCache.image, "infisical")).get();
      if (!cached?.upstreamDigest) throw new Error("no upstream digest cached for infisical");
      return;
    }
    const entry = CATALOG[req.image];
    if (!entry) throw new Error(`unknown image: ${String(req.image)}`);
    const cached = db.select().from(schema.imageVersionCache)
      .where(eq(schema.imageVersionCache.image, req.image)).get();
    if (!cached) throw new Error(`no cache row for ${req.image} — refresh poller first`);
    const allowed = new Set<string>();
    if (cached.newestWithinMajor) allowed.add(cached.newestWithinMajor);
    if (cached.newestAcrossMajor) allowed.add(cached.newestAcrossMajor);
    // Idempotent re-apply of current pin
    const currentTag = this.env.readPin(req.image).split(":").slice(1).join(":");
    if (currentTag) allowed.add(currentTag);
    if (!allowed.has(req.tag)) {
      throw new Error(`tag ${req.tag} not in {within=${cached.newestWithinMajor}, across=${cached.newestAcrossMajor}, current=${currentTag}}`);
    }
    if (req.tag === cached.newestAcrossMajor && !req.acknowledgedMajor) {
      throw new Error("major version bump requires acknowledgedMajor=true");
    }
  }

  async applyImageUpdate(
    req: ApplyRequest,
    onEvent: (e: ApplyEvent) => void,
  ): Promise<void> {
    onEvent({ kind: "phase", phase: "validating" });
    this.validateApply(req);

    const entry = CATALOG[req.image];
    onEvent({ kind: "phase", phase: "writing-env" });
    const backupPath = this.env.backupEnv();
    let envChanged = false;
    if (!("digestUpdate" in req)) {
      this.env.writePin(req.image, `${entry.repo}:${req.tag}`);
      envChanged = true;
    }

    try {
      onEvent({ kind: "phase", phase: "pulling" });
      await runDocker(["compose", "-f", COMPOSE_PATH, "pull", entry.composeService], onEvent);
      onEvent({ kind: "phase", phase: "recreating" });
      await runDocker(
        ["compose", "-f", COMPOSE_PATH, "up", "-d", "--no-deps", entry.composeService],
        onEvent,
      );
      onEvent({ kind: "phase", phase: "done" });
      this.env.pruneOldBackups(3);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent({ kind: "error", message: `Apply failed: ${msg}. Rolling back.` });
      if (envChanged) this.env.restoreEnv(backupPath);
      try {
        await runDocker(
          ["compose", "-f", COMPOSE_PATH, "up", "-d", "--no-deps", entry.composeService],
          onEvent,
        );
        onEvent({ kind: "phase", phase: "failed" });
      } catch (rollbackErr) {
        const rmsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        onEvent({
          kind: "error",
          message: `Rollback also failed: ${rmsg}. Manual intervention required. Backup: ${backupPath}`,
        });
        onEvent({ kind: "phase", phase: "failed" });
      }
    }
  }
}

function runDocker(args: readonly string[], onEvent: (e: ApplyEvent) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const emit = (buf: Buffer) => {
      for (const line of buf.toString("utf8").split(/\r?\n/)) {
        if (line.length > 0) onEvent({ kind: "log", line });
      }
    };
    child.stdout.on("data", emit);
    child.stderr.on("data", emit);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker ${args.join(" ")} exited ${String(code)}`));
    });
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/images/manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/images/manager.ts packages/server/src/services/images/manager.test.ts
git commit -m "feat(updates): aggregator + apply orchestrator"
```

---

## Task 9: Shared update lock

**Files:**
- Create: `packages/server/src/services/update-lock.ts`
- Modify: `packages/server/src/routes/admin.ts`
- Test: `packages/server/src/services/update-lock.test.ts`

The current AgentHub binary update path (`POST /api/admin/update` in `admin.ts`) does NOT serialize concurrent updates. This task introduces a shared lock module and wires it into both the existing AgentHub update path and (in Task 10) the new image apply path.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/services/update-lock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { tryAcquireUpdateLock, releaseUpdateLock } from "./update-lock.js";

describe("update-lock", () => {
  it("second acquire fails while the first holder hasn't released", () => {
    const a = tryAcquireUpdateLock("agenthub");
    expect(a).toBe(true);
    const b = tryAcquireUpdateLock("image");
    expect(b).toBe(false);
    releaseUpdateLock();
    const c = tryAcquireUpdateLock("image");
    expect(c).toBe(true);
    releaseUpdateLock();
  });

  it("releasing without a holder is a no-op", () => {
    releaseUpdateLock();
    expect(tryAcquireUpdateLock("image")).toBe(true);
    releaseUpdateLock();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/update-lock.test.ts`
Expected: FAIL (module-not-found).

- [ ] **Step 3: Write `update-lock.ts`**

Create `packages/server/src/services/update-lock.ts`:

```ts
/**
 * Process-wide mutex shared between the AgentHub binary update path
 * (`POST /api/admin/update`) and the image apply path
 * (`POST /api/admin/updates/image`). Both mutate the docker stack and
 * cannot safely run in parallel.
 *
 * In-memory only — fine because there's one agenthub-server process. If
 * we ever go multi-replica this needs to move to SQLite or Redis.
 */

let holder: string | null = null;

export function tryAcquireUpdateLock(by: string): boolean {
  if (holder !== null) return false;
  holder = by;
  return true;
}

export function releaseUpdateLock(): void {
  holder = null;
}

export function currentLockHolder(): string | null {
  return holder;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/update-lock.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the lock to admin.ts's update path**

In `packages/server/src/routes/admin.ts`, find the `POST /update` route (search `update`; it's the one that spawns the `agenthub-updater-${jobId}` container). Wrap its handler body to:

1. At the top: `if (!tryAcquireUpdateLock("agenthub")) return c.json({ error: "another update is in progress" }, 409);`
2. In the cleanup path (the same place the container spawn fails or where progress polling completes): `releaseUpdateLock();`

Note: the existing AgentHub update is fire-and-forget — the route returns once the updater container is spawned, but the actual update keeps running. The lock needs to be held until the updater container is observed to have exited (or fails to start). If the existing code doesn't have a clean "updater finished" hook, release the lock when the `agenthub-server` container itself comes back online (the polling logic at `/api/admin/version` runs client-side, so the server has to track this separately). The simplest correct option: hold the lock until the spawned updater container exits — poll its status from `admin.ts:317`-area code that's already there for the SSE log stream, or add a `child.on("exit")` handler if it spawns via `child_process` directly. Match the existing observation pattern; do not introduce a new one.

Add this import at the top of `admin.ts`:

```ts
import { releaseUpdateLock, tryAcquireUpdateLock } from "../services/update-lock.js";
```

Run the full server test suite to confirm no regression:

Run: `pnpm --filter @agenthub/server test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/update-lock.ts packages/server/src/services/update-lock.test.ts packages/server/src/routes/admin.ts
git commit -m "feat(updates): shared update lock"
```

---

## Task 10: Admin-updates routes (TDD)

**Files:**
- Create: `packages/server/src/routes/admin-updates.ts`
- Test: `packages/server/src/routes/admin-updates.test.ts`
- Modify: `packages/server/src/index.ts` (mount the route)

**Context:** Admin gating is applied **globally** via `app.use("/api/admin/*", adminMiddleware)` at `packages/server/src/index.ts:178`. Don't add per-route admin checks. The mounting pattern (per `app.route("/api/admin/install-backup", installBackupRoutes())` at `index.ts:181`) is: the routes module exports a factory that returns a Hono instance.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/routes/admin-updates.test.ts`:

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { db, schema, initDb } from "../db/index.js";
import { adminUpdatesRoutes } from "./admin-updates.js";
import { releaseUpdateLock, tryAcquireUpdateLock } from "../services/update-lock.js";
import { EnvOverrides } from "../services/images/env-overrides.js";

beforeAll(() => { initDb(); });

function makeApp(envPath: string) {
  const env = new EnvOverrides({ envPath });
  const root = new Hono();
  root.route(
    "/api/admin/updates",
    adminUpdatesRoutes({ env, runningDigest: () => Promise.resolve(null) }),
  );
  return root;
}

describe("GET /api/admin/updates", () => {
  let dir: string;
  beforeEach(() => {
    db.delete(schema.imageVersionCache).run();
    dir = mkdtempSync(join(tmpdir(), "ar-"));
    writeFileSync(join(dir, ".env"), "");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns one row per image", async () => {
    const app = makeApp(join(dir, ".env"));
    const res = await app.request("/api/admin/updates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { images: unknown[] };
    expect(body.images).toHaveLength(4);
  });
});

describe("POST /api/admin/updates/image", () => {
  let dir: string;
  beforeEach(() => {
    db.delete(schema.imageVersionCache).run();
    dir = mkdtempSync(join(tmpdir(), "ar-"));
    writeFileSync(join(dir, ".env"), "");
    releaseUpdateLock();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns 409 when another update holds the lock", async () => {
    tryAcquireUpdateLock("agenthub");
    const app = makeApp(join(dir, ".env"));
    const res = await app.request("/api/admin/updates/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: "traefik", tag: "v3.7" }),
    });
    expect(res.status).toBe(409);
    releaseUpdateLock();
  });

  it("returns 400 for a major bump without acknowledgedMajor", async () => {
    db.insert(schema.imageVersionCache).values({
      image: "traefik", pinnedTag: "traefik:v3.6",
      newestWithinMajor: "v3.7.1", newestAcrossMajor: "v4.0",
      upstreamDigest: null, lastCheckedAt: new Date(), lastError: null,
    }).run();
    const app = makeApp(join(dir, ".env"));
    const res = await app.request("/api/admin/updates/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: "traefik", tag: "v4.0" }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run src/routes/admin-updates.test.ts`
Expected: FAIL (module-not-found).

- [ ] **Step 3: Write `admin-updates.ts`**

Create `packages/server/src/routes/admin-updates.ts`:

```ts
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { ImagesManager, type ApplyRequest } from "../services/images/manager.js";
import type { EnvOverrides } from "../services/images/env-overrides.js";
import type { RunningDigestResolver } from "../services/images/manager.js";
import { releaseUpdateLock, tryAcquireUpdateLock } from "../services/update-lock.js";

export interface AdminUpdatesDeps {
  readonly env: EnvOverrides;
  readonly runningDigest: RunningDigestResolver;
}

/**
 * Factory mirroring the pattern of `installBackupRoutes()` / `adminRoutes()`.
 * The caller mounts the returned app at `/api/admin/updates`; admin-gating
 * is applied globally via `app.use("/api/admin/*", adminMiddleware)` in
 * `index.ts`, so no per-route guard is needed here.
 */
export function adminUpdatesRoutes(deps: AdminUpdatesDeps): Hono {
  const app = new Hono();
  const mgr = new ImagesManager(deps.env, deps.runningDigest);

  app.get("/", async (c: Context) => {
    return c.json(await mgr.getUpdatesSummary());
  });

  app.post("/refresh", async (c: Context) => {
    // The poller is owned by index.ts; refresh is a hint, not an obligation.
    // The page will see fresh data on next GET.
    return c.json({ accepted: true }, 202);
  });

  app.post("/image", async (c: Context) => {
    const body = (await c.req.json()) as ApplyRequest;
    if (!tryAcquireUpdateLock("image")) {
      return c.json({ error: "another update is in progress" }, 409);
    }
    try {
      mgr.validateApply(body);
    } catch (err) {
      releaseUpdateLock();
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
    return streamSSE(c, async (stream) => {
      try {
        await mgr.applyImageUpdate(body, (e) => {
          if (e.kind === "phase") void stream.writeSSE({ event: "phase", data: e.phase });
          else if (e.kind === "log") void stream.writeSSE({ event: "log", data: e.line });
          else void stream.writeSSE({ event: "error", data: e.message });
        });
      } finally {
        releaseUpdateLock();
        await stream.writeSSE({ event: "end", data: "" });
      }
    });
  });

  return app;
}
```

- [ ] **Step 4: Mount the route in `index.ts`**

In `packages/server/src/index.ts`, immediately after the existing `app.route("/api/admin/install-backup", installBackupRoutes())` line at `index.ts:181`, add:

```ts
import { adminUpdatesRoutes } from "./routes/admin-updates.js";
import { EnvOverrides } from "./services/images/env-overrides.js";
import { dockerRunningDigest } from "./services/images/manager.js";

// ...inside the file, alongside other module-level setup, BEFORE the route mount:
const envOverrides = new EnvOverrides({ envPath: "compose/.env" });

// ...alongside the install-backup mount:
app.route("/api/admin/updates", adminUpdatesRoutes({
  env: envOverrides,
  runningDigest: dockerRunningDigest(),
}));
```

The `envOverrides` instance is also used by Task 11 (poller wiring). Keep it module-scoped so both consumers share one instance.

- [ ] **Step 5: Implement `runningDigest` resolver**

In `packages/server/src/services/images/manager.ts`, add at the bottom:

```ts
/**
 * Returns the digest of the image currently running for a given compose
 * service, or null on any failure. Used by the page's "is a new digest
 * available?" detection for digest-mode pins.
 */
export function dockerRunningDigest(): RunningDigestResolver {
  return async (service: string) => {
    return new Promise((resolve) => {
      const child = spawn("docker", [
        "compose",
        "-f", process.env.COMPOSE_FILE ?? "compose/docker-compose.yml",
        "images", "--quiet", service,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let buf = "";
      child.stdout.on("data", (d: Buffer) => { buf += d.toString("utf8"); });
      child.on("error", () => resolve(null));
      child.on("close", (code) => {
        if (code !== 0) { resolve(null); return; }
        const imageId = buf.trim().split("\n")[0];
        if (!imageId) { resolve(null); return; }
        const inspect = spawn("docker", ["inspect", "--format", "{{ (index .RepoDigests 0) }}", imageId], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        inspect.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
        inspect.on("error", () => resolve(null));
        inspect.on("close", (c2) => {
          if (c2 !== 0) { resolve(null); return; }
          const ref = out.trim();
          const at = ref.indexOf("@");
          resolve(at === -1 ? null : ref.slice(at + 1));
        });
      });
    });
  };
}
```

The `dockerRunningDigest` import was already added in Step 4 above.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @agenthub/server exec vitest run src/routes/admin-updates.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full server test suite**

Run: `pnpm --filter @agenthub/server test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/routes/admin-updates.ts packages/server/src/routes/admin-updates.test.ts packages/server/src/services/images/manager.ts packages/server/src/index.ts
git commit -m "feat(updates): admin-updates routes + running-digest probe"
```

---

## Task 11: Wire ImagePoller into server startup

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Add `ImagePoller` startup next to `VersionPoller`**

In `packages/server/src/index.ts`, immediately after the existing two lines at `index.ts:64-65`:

```ts
const versionPoller = new VersionPoller();
versionPoller.start();
```

add:

```ts
import { ImagePoller } from "./services/images/poller.js";
import { DockerHubClient } from "./services/images/registry-client.js";
// ...later in the file, after `versionPoller.start()`:
const imagePoller = new ImagePoller(envOverrides, new DockerHubClient());
imagePoller.start();
```

`envOverrides` is the same `EnvOverrides` instance created in Task 10 Step 4. Reuse the module-scoped variable; do not instantiate a second copy.

- [ ] **Step 2: Run server typecheck + tests**

Run: `pnpm typecheck && pnpm --filter @agenthub/server test`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "feat(updates): start ImagePoller on server boot"
```

---

## Task 12: Extract `AgentHubPanel` from Settings.tsx

**Files:**
- Create: `packages/web/src/components/updates/AgentHubPanel.tsx`
- Modify: `packages/web/src/pages/Settings.tsx`

- [ ] **Step 1: Identify the exact range to extract**

Re-read `packages/web/src/pages/Settings.tsx`. The `VersionPanel` function and its supporting types/constants/helpers (`UpdateProgressBase`, `UpdateProgress`, `UPDATE_TIMEOUT_MS`, `MAX_LOG_LINES`, `stripAnsi`, `StreamState`, `UpdatePhase`, `PHASE_RANK`) form a self-contained block. Also identify the `import` lines they need (api, UpdateProgressModal, useState/useEffect/useCallback/useRef).

Note: the existing component is named `VersionPanel`. We're renaming it to `AgentHubPanel` to match the spec.

- [ ] **Step 2: Create `AgentHubPanel.tsx`**

Create `packages/web/src/components/updates/AgentHubPanel.tsx` and paste in the extracted block. Rename the function from `VersionPanel` to `AgentHubPanel`. Export it as a named export. Make sure every import is rewritten with the correct relative path (`../../lib/api.ts`, `../UpdateProgressModal.tsx`, etc.).

Behavior must be unchanged — no logic edits in this step.

- [ ] **Step 3: Remove the same block from `Settings.tsx`**

Delete the extracted types, constants, helpers, and the `VersionPanel` component from `Settings.tsx`. Also remove the `{user?.role === "admin" && <VersionPanel />}` call site — no link back to Updates (per the spec's "replace, don't deprecate"). Clean up any now-unused imports.

- [ ] **Step 4: Confirm Settings still typechecks + builds**

Run: `pnpm --filter @agenthub/web exec tsc --noEmit && pnpm --filter @agenthub/web build`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/updates/AgentHubPanel.tsx packages/web/src/pages/Settings.tsx
git commit -m "refactor(updates): extract AgentHubPanel from Settings"
```

---

## Task 13: ImagePinsTable component

**Files:**
- Create: `packages/web/src/components/updates/ImagePinsTable.tsx`
- Create: `packages/web/src/components/updates/ImageRowConfirmModal.tsx`

- [ ] **Step 1: Create `ImageRowConfirmModal.tsx`**

```tsx
import { useState } from "react";

interface ImageRowConfirmModalProps {
  readonly displayName: string;
  readonly currentTag: string;
  readonly targetTag: string;
  readonly disruption: string;
  readonly isMajor: boolean;
  readonly onConfirm: (acknowledgedMajor: boolean) => void;
  readonly onCancel: () => void;
}

export function ImageRowConfirmModal(props: ImageRowConfirmModalProps): JSX.Element {
  const [acked, setAcked] = useState(false);
  const canConfirm = !props.isMajor || acked;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-md bg-zinc-900 p-6 shadow-xl">
        <h3 className="text-lg font-semibold">Update {props.displayName}</h3>
        <p className="mt-2 text-sm text-zinc-400">
          <code className="text-zinc-300">{props.currentTag}</code>
          {" → "}
          <code className="text-zinc-300">{props.targetTag}</code>
        </p>
        <p className="mt-3 text-sm text-zinc-300">{props.disruption}</p>
        {props.isMajor && (
          <label className="mt-4 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={acked}
              onChange={(e) => setAcked(e.target.checked)}
              className="mt-0.5"
            />
            <span className="text-amber-400">
              I understand this is a major version upgrade and may require migration.
            </span>
          </label>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => props.onConfirm(acked)}
          >
            Update
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `ImagePinsTable.tsx`**

```tsx
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { ImageRowConfirmModal } from "./ImageRowConfirmModal.tsx";

type ImageKey = "traefik" | "postgres" | "redis" | "infisical";

interface ImageRow {
  readonly image: ImageKey;
  readonly displayName: string;
  readonly pinnedTag: string;
  readonly newestWithinMajor: string | null;
  readonly newestAcrossMajor: string | null;
  readonly upstreamDigest: string | null;
  readonly runningDigest: string | null;
  readonly updateAvailable: boolean;
  readonly lastCheckedAt: string | null;
  readonly lastError: string | null;
  readonly disruption: string;
}

interface PendingApply {
  readonly image: ImageKey;
  readonly tag: string | "DIGEST";
  readonly isMajor: boolean;
}

const MAX_LOG_LINES = 200;

function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export function ImagePinsTable(): JSX.Element {
  const [rows, setRows] = useState<readonly ImageRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingApply | null>(null);
  const [progressImage, setProgressImage] = useState<ImageKey | null>(null);
  const [phase, setPhase] = useState<string>("");
  const [logLines, setLogLines] = useState<readonly string[]>([]);
  const [opError, setOpError] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    try {
      const res = await api("/api/admin/updates");
      if (!res.ok) {
        const b = (await res.json()) as { error?: string };
        setLoadError(b.error ?? `HTTP ${String(res.status)}`);
        return;
      }
      const body = (await res.json()) as { images: readonly ImageRow[] };
      setRows(body.images);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "load failed");
    }
  }, []);

  useEffect(() => { void fetchRows(); }, [fetchRows]);

  const startApply = (image: ImageKey, tag: string | "DIGEST", isMajor: boolean) => {
    setOpError(null);
    setLogLines([]);
    setPhase("");
    setPending({ image, tag, isMajor });
  };

  const confirmApply = async (ack: boolean) => {
    if (!pending) return;
    const body =
      pending.tag === "DIGEST"
        ? { image: "infisical", digestUpdate: true }
        : { image: pending.image, tag: pending.tag, acknowledgedMajor: ack };
    setPending(null);
    setProgressImage(pending.image);
    const res = await fetch("/api/admin/updates/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      setOpError(b.error ?? `HTTP ${String(res.status)}`);
      setProgressImage(null);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const block of events) {
        let evt = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) evt = line.slice(6).trim();
          else if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (evt === "phase") setPhase(data);
        else if (evt === "log") {
          const line = stripAnsi(data);
          setLogLines((prev) => {
            const next = [...prev, line];
            return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
          });
        } else if (evt === "error") setOpError(data);
      }
    }
    setProgressImage(null);
    void fetchRows();
  };

  return (
    <div className="rounded-md border border-zinc-800 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-semibold">Container image pins</h3>
        <button
          type="button"
          onClick={() => void fetchRows()}
          className="text-xs text-zinc-400 hover:text-zinc-200"
        >
          Refresh
        </button>
      </div>
      {loadError && <p className="text-sm text-red-400">{loadError}</p>}
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-zinc-500">
          <tr>
            <th className="py-2">Image</th>
            <th>Pinned</th>
            <th>Within-major</th>
            <th>Major bump</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isDigestMode = r.image === "infisical";
            const digestNewer = !!(r.upstreamDigest && r.runningDigest && r.upstreamDigest !== r.runningDigest);
            return (
              <tr key={r.image} className="border-t border-zinc-800">
                <td className="py-2">{r.displayName}</td>
                <td><code className="text-zinc-300">{r.pinnedTag}</code></td>
                <td>
                  {isDigestMode
                    ? <span className="text-zinc-500">digest mode</span>
                    : r.newestWithinMajor
                      ? <span className="text-sky-300">{r.newestWithinMajor}</span>
                      : <span className="text-zinc-500">—</span>}
                </td>
                <td>
                  {r.newestAcrossMajor
                    ? <span className="text-amber-400">{r.newestAcrossMajor} ⚠</span>
                    : <span className="text-zinc-500">—</span>}
                </td>
                <td className="text-right">
                  {isDigestMode && digestNewer && (
                    <button
                      type="button"
                      onClick={() => startApply(r.image, "DIGEST", false)}
                      className="rounded-md bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-500"
                    >
                      Pull new digest
                    </button>
                  )}
                  {!isDigestMode && r.newestWithinMajor && (
                    <button
                      type="button"
                      onClick={() => startApply(r.image, r.newestWithinMajor!, false)}
                      className="rounded-md bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-500"
                    >
                      Update to {r.newestWithinMajor}
                    </button>
                  )}
                  {!isDigestMode && r.newestAcrossMajor && !r.newestWithinMajor && (
                    <button
                      type="button"
                      onClick={() => startApply(r.image, r.newestAcrossMajor!, true)}
                      className="rounded-md bg-amber-600 px-2.5 py-1 text-xs text-white hover:bg-amber-500"
                    >
                      Update to {r.newestAcrossMajor}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {progressImage && (
        <div className="mt-4 rounded-md bg-zinc-950 p-3 font-mono text-xs">
          <div className="mb-2 text-zinc-400">Phase: {phase}</div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap">
            {logLines.join("\n")}
          </pre>
        </div>
      )}
      {opError && <p className="mt-3 text-sm text-red-400">{opError}</p>}
      {pending && (() => {
        const row = rows.find((r) => r.image === pending.image);
        if (!row) return null;
        return (
          <ImageRowConfirmModal
            displayName={row.displayName}
            currentTag={row.pinnedTag}
            targetTag={pending.tag === "DIGEST" ? "(new digest)" : pending.tag}
            disruption={row.disruption}
            isMajor={pending.isMajor}
            onConfirm={(ack) => void confirmApply(ack)}
            onCancel={() => setPending(null)}
          />
        );
      })()}
    </div>
  );
}
```

- [ ] **Step 3: Build + typecheck**

Run: `pnpm --filter @agenthub/web exec tsc --noEmit && pnpm --filter @agenthub/web build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/updates/ImagePinsTable.tsx packages/web/src/components/updates/ImageRowConfirmModal.tsx
git commit -m "feat(updates): ImagePinsTable + confirm modal"
```

---

## Task 14: Updates page + route + nav

**Files:**
- Create: `packages/web/src/pages/admin/Updates.tsx`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/components/Sidebar.tsx`

- [ ] **Step 1: Create the page**

Create `packages/web/src/pages/admin/Updates.tsx`:

```tsx
import { AgentHubPanel } from "../../components/updates/AgentHubPanel.tsx";
import { ImagePinsTable } from "../../components/updates/ImagePinsTable.tsx";

export function UpdatesPage(): JSX.Element {
  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-semibold">Updates</h2>
        <p className="mt-1 text-sm text-zinc-500">
          System update visibility and apply actions.
        </p>
      </div>
      <div className="space-y-6">
        <AgentHubPanel />
        <ImagePinsTable />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Register the route in `App.tsx`**

In `packages/web/src/App.tsx`, immediately below the existing `/admin/install-backup` Route declaration, add:

```tsx
<Route path="/admin/updates" element={<UpdatesPage />} />
```

Add the import at the top:

```tsx
import { UpdatesPage } from "./pages/admin/Updates.tsx";
```

- [ ] **Step 3: Add the nav item to `Sidebar.tsx`**

Open `packages/web/src/components/Sidebar.tsx`. Find the existing admin-section nav rendering (where `/admin/install-backup` appears). Add a new admin-gated link to `/admin/updates` with the label "Updates". Match the visual treatment of the adjacent admin links exactly.

- [ ] **Step 4: Build + typecheck**

Run: `pnpm --filter @agenthub/web exec tsc --noEmit && pnpm --filter @agenthub/web build`
Expected: no errors.

- [ ] **Step 5: Smoke-test in the dev server**

Run: `pnpm dev` (in another terminal). In a browser, log in as admin, navigate to `/admin/updates`. Confirm:
- The page loads without console errors.
- AgentHub panel renders with the same content it had on Settings.
- Image pins table renders 4 rows.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/pages/admin/Updates.tsx packages/web/src/App.tsx packages/web/src/components/Sidebar.tsx
git commit -m "feat(updates): /admin/updates page + nav entry"
```

---

## Task 15: Full-suite check + fresh-VM verification checklist

**Files:** none (verification only)

- [ ] **Step 1: Run full typecheck + lint + test across the monorepo**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 2: Fresh-VM verification**

Stand up a clean VM per the test pipeline (clone template 9001 → resize → start on pve05). Deploy the branch using `AGENTHUB_BRANCH=<this-branch>` on the quick-install one-liner.

Run through each item below in order. Mark each as ✅ or ❌. Any ❌ blocks merge.

- [ ] Poll cycle runs at startup. After ~30s, `select * from image_version_cache` shows 4 rows. Run inside the server container:
  ```
  docker exec agenthub-agenthub-server-1 sqlite3 /data/agenthub.db "select image, pinned_tag, newest_within_major, newest_across_major, upstream_digest, last_error from image_version_cache"
  ```
  Expect: 4 rows, no `last_error`, at least Traefik/Postgres/Redis have `newest_within_major` set, Infisical has `upstream_digest`.
- [ ] The `/admin/updates` page renders with the expected rows.
- [ ] Apply a within-major Traefik bump (`v3.6 → v3.7` or current latest). Verify the confirmation modal shows the Traefik disruption blurb. Apply. Modal shows phase progression. After "done", AgentHub UI and Infisical console both reachable.
- [ ] Inspect `compose/.env` on the VM: `TRAEFIK_IMAGE=traefik:v3.7` line present.
- [ ] Attempt a major Postgres bump (`16-alpine → 17-alpine`) WITHOUT checking the ack box. Verify the UI's Update button is disabled.
- [ ] Check the major-bump ack box and apply. Confirm postgres recreates, Infisical reconnects after the healthcheck window, agenthub-server's secret resolves recover. (If 17-alpine isn't available for some reason, skip this case — it's not a hard blocker.)
- [ ] Rollback path: pin Traefik to a deliberately invalid tag by writing `TRAEFIK_IMAGE=traefik:vnonexistent` directly to `.env`, restart the stack to load the bad pin, then use the page to update back to a valid version. Confirm the apply succeeds. (We're verifying recovery from a known-bad state, not provoking failure mid-apply since that's hard to script reliably.)
- [ ] Run `agenthub update` on the VM with operator pin overrides in `.env`. Confirm `compose/.env` survives `git pull` and the operator's pin is honored by `up -d`.
- [ ] Trigger AgentHub binary update AND open the Updates page in another tab. Click any image-Update row; confirm 409 is surfaced (or vice versa: trigger image update first, then attempt binary update).

- [ ] **Step 3: If everything passes, open the PR**

Use `gh pr create` per the global standard. Title: `feat(updates): Phase 2 — admin Updates page`. Body: link to the spec, list the verification checklist with ✅/❌ marks.

---

## End of plan
