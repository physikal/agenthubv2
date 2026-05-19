# Updates page — design spec

**Phase 2** of the CLI-freshness + Sandcastle roadmap. Phase 1 (CLI catalog migration) shipped 2026-05-18 as `e0668f1`.

## Goal

Give operators a single admin surface for visibility and apply-action on what's drifted in their install: the AgentHub binary itself, plus the four pinned container images (Traefik, Postgres, Redis, Infisical). Per-user CLI freshness stays on the existing Packages page.

## Scope

**In:**
- New admin-only `/admin/updates` page.
- AgentHub binary update panel (moved from Settings, no behavior change).
- Container image pins table covering: `traefik`, `infisical-postgres`, `infisical-redis`, `infisical`.
- Scheduled poll (30 min, jittered) against Docker Hub for upstream tags + manifest digests.
- Per-row "Update" action that mutates `compose/.env` and recreates that single service.
- Confirmation modal for major-version bumps.

**Out (deferred to later phases):**
- Docker engine drift detection / apply.
- Host OS `apt` drift detection / apply.
- Operator-behind-main detection (i.e., showing individual sub-rows of what `agenthub update` would change). Today the binary panel already says "N commits behind"; that's sufficient.
- Per-user CLI updates (stay on Packages page).

## Architecture

```
                ┌────────────────────────────────────────────────────┐
                │  /admin/updates page (admin-only)                  │
                │                                                    │
                │   ┌──────────────────────────────────────────┐    │
                │   │ AgentHub panel  (moved from Settings)    │    │
                │   │  current sha · behind count · Update btn │    │
                │   └──────────────────────────────────────────┘    │
                │   ┌──────────────────────────────────────────┐    │
                │   │ Container image pins · table             │    │
                │   │  traefik | postgres | redis | infisical  │    │
                │   │  per-row Update with confirmation modal  │    │
                │   └──────────────────────────────────────────┘    │
                └────────────────────────────────────────────────────┘
                                       │
                                       ▼
   GET /api/admin/updates ─────────────┐
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
  binary section               image-pins section              freshness meta
   • current sha               • for each pin                  • last polled at
   • main HEAD sha             • current tag                   • next poll due
   • behind / ahead            • upstream newest within-major  • errors per row
   (reuses /api/admin/          • upstream newest across-major
    version data)               (from image_version_cache)

  POST /api/admin/updates/agenthub  → existing AgentHub update flow (unchanged)
  POST /api/admin/updates/image     → mutate .env + recreate one service
       body: { image, tag, acknowledgedMajor? }
       SSE: phase events + docker stdout/stderr log lines

  POST /api/admin/updates/refresh   → admin-only on-demand poll trigger
```

## Data model

### New SQLite table

```ts
// packages/server/src/db/schema.ts
export const imageVersionCache = sqliteTable("image_version_cache", {
  // Logical pin key: "traefik" | "postgres" | "redis" | "infisical".
  // NOT the registry slug; lets us swap registries without losing rows.
  image: text("image").primaryKey(),

  // What's currently pinned (read from .env at poll time; falls back to
  // compose.yml default if no override set).
  pinnedTag: text("pinned_tag").notNull(),

  // Upstream newest within the currently-pinned major. Null = poller
  // hasn't run, or registry errored. Safe-class upgrade target.
  newestWithinMajor: text("newest_within_major"),

  // Upstream newest across all majors > current. Null = no major bump
  // available. Risky-class target; requires acknowledgedMajor: true.
  newestAcrossMajor: text("newest_across_major"),

  // For "latest-*" / digest-tracking pins (Infisical), we track the
  // manifest digest the tag resolves to. Null for semver pins.
  upstreamDigest: text("upstream_digest"),

  lastCheckedAt: integer("last_checked_at", { mode: "timestamp_ms" }),
  lastError: text("last_error"),  // cleared on success
});

export type ImageVersionCache = typeof imageVersionCache.$inferSelect;
export type NewImageVersionCache = typeof imageVersionCache.$inferInsert;
```

### compose.yml refactor

Add env-override wrappers for each pinned image, keeping current values as defaults:

```yaml
traefik:           image: ${TRAEFIK_IMAGE:-traefik:v3.6}
infisical-postgres: image: ${POSTGRES_IMAGE:-postgres:16-alpine}
infisical-redis:   image: ${REDIS_IMAGE:-redis:7-alpine}
infisical:         image: ${INFISICAL_IMAGE:-infisical/infisical:latest-postgres}
```

Operator bumps write to `compose/.env`. `agenthub update`'s `git pull` refreshes compose.yml; `.env` stays; `up -d` interpolates the operator's pin.

### Pin classification

| Image | Mode | Tag pattern | Notes |
|---|---|---|---|
| traefik | semver | `^v(\d+)\.(\d+)(\.\d+)?$` | strip leading `v` for compare |
| postgres | semver | `^(\d+)(?:-alpine)?$` | preserve `-alpine` suffix in chosen tag |
| redis | semver | `^(\d+)(?:-alpine)?$` | preserve `-alpine` suffix |
| infisical | digest | tracks whatever tag is pinned | default pin is `latest-postgres`; operator may override |

Pins that don't match the policy regex (operator hand-edited to `traefik:v3.6.4-rc.1`, etc.) render as read-only "Unknown tag format — manual updates only."

## Files to create

```
packages/server/src/db/schema.ts                       (extend with imageVersionCache)
packages/server/src/services/images/
  catalog.ts                                            (4-image catalog + service-name mapping + disruption blurbs)
  pin-policy.ts                                         (semver matcher per image, digest mode)
  registry-client.ts                                    (Docker Hub tags + manifest digest fetcher)
  poller.ts                                             (scheduled 30-min poll, mirrors packages/poller.ts)
  env-overrides.ts                                      (read pin from .env + compose.yml default; upsert writer)
  manager.ts                                            (orchestrator the routes call)
  *.test.ts                                             (one per module above)
packages/server/src/routes/admin-updates.ts             (GET /api/admin/updates, POST .../image, .../refresh)
packages/web/src/pages/admin/Updates.tsx                (new page composing the two panels)
packages/web/src/components/updates/AgentHubPanel.tsx  (extracted from Settings.tsx)
packages/web/src/components/updates/ImagePinsTable.tsx (table + row + confirmation modal)
docs/superpowers/specs/2026-05-18-updates-page-design.md (this file)
docs/superpowers/plans/2026-05-18-updates-page.md       (created by writing-plans skill)
```

## Files to modify

```
compose/docker-compose.yml                              (add ${VAR:-default} to 4 image lines)
packages/web/src/pages/Settings.tsx                     (remove VersionPanel block + UpdateProgress types)
packages/web/src/App.tsx                                (register /admin/updates route)
packages/web/src/components/Sidebar.tsx                 (admin-gated /admin/updates nav item)
packages/server/src/index.ts                            (start the image poller alongside the existing package poller)
```

## Components

### `services/images/registry-client.ts`

Two HTTP operations against Docker Hub (public registry, no auth needed):

1. `listTags(repo, maxPages)` → `GET https://hub.docker.com/v2/repositories/{repo}/tags?page_size=100`, paginate up to `maxPages` (default 5 → max 500 recent tags). Returns flat `string[]` of tag names.
2. `getDigest(repo, tag)` → registry-v2 manifest fetch with anonymous bearer flow:
   - `GET https://auth.docker.io/token?service=registry.docker.io&scope=repository:{repo}:pull` → bearer token
   - `GET https://registry-1.docker.io/v2/{repo}/manifests/{tag}` with `Accept: application/vnd.docker.distribution.manifest.v2+json` + the bearer → response's `Docker-Content-Digest` header.

Retries: none in v1. A transient 503 lands in `lastError`; next 30-min poll retries.

Rate-limits: Docker Hub's anonymous limit is 100 pulls/6h per source IP for image pulls; the metadata endpoints (`/v2/repositories/...` and `/v2/.../manifests/...`) are not pull-counted, so 4 images × ~3 requests every 30 min is safely under.

### `services/images/pin-policy.ts`

```ts
export type ImageKey = 'traefik' | 'postgres' | 'redis' | 'infisical';

type PinPolicy =
  | { mode: 'semver'; matcher: RegExp; extract: (m: RegExpMatchArray) => SemverParts }
  | { mode: 'digest' };  // Tracks the manifest digest of whatever tag is currently pinned.

interface SemverParts { major: number; minor: number; patch: number; raw: string; variant?: string }

export const PIN_POLICY: Record<ImageKey, PinPolicy> = {
  traefik: {
    mode: 'semver',
    matcher: /^v(\d+)\.(\d+)(?:\.(\d+))?$/,
    extract: (m) => ({
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: m[3] ? Number(m[3]) : 0,
      raw: m[0],
    }),
  },
  postgres: {
    mode: 'semver',
    matcher: /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(-alpine)?$/,
    extract: (m) => ({
      major: Number(m[1]),
      minor: m[2] ? Number(m[2]) : 0,
      patch: m[3] ? Number(m[3]) : 0,
      raw: m[0],
      variant: m[4] ?? undefined,
    }),
  },
  redis: { /* same shape as postgres */ },
  infisical: { mode: 'digest' },
};

export function classify(tag: string, policy: PinPolicy): SemverParts | 'unknown';
export function newestWithinMajor(tags: SemverParts[], pinnedMajor: number): SemverParts | null;
export function newestAcrossMajor(tags: SemverParts[], pinnedMajor: number): SemverParts | null;
```

For `postgres`/`redis`, the matcher honors `-alpine` only when the currently-pinned tag has it — i.e., if the operator pins `postgres:16-alpine`, `newestWithinMajor` returns the newest `16.x.x-alpine`, not `16.x.x`. Variant is treated as a sticky filter, not a free-floating axis.

### `services/images/poller.ts`

Pseudocode:

```ts
const POLL_INTERVAL_MS = 30 * 60 * 1000;
const JITTER_MS = 2 * 60 * 1000;

export function startImagePoller(db, registry, envOverrides): () => void {
  const run = async () => {
    for (const image of CATALOG_KEYS) {
      try {
        const pinned = envOverrides.readPin(image);
        const policy = PIN_POLICY[image];
        if (policy.mode === 'semver') {
          const tags = await registry.listTags(CATALOG[image].repo);
          const parsed = tags.flatMap(t => classifyOrDrop(t, policy));
          const pinnedParts = classify(pinned, policy);
          const major = pinnedParts === 'unknown' ? null : pinnedParts.major;
          upsert(db, {
            image,
            pinnedTag: pinned,
            newestWithinMajor: major ? newestWithinMajor(parsed, major)?.raw ?? null : null,
            newestAcrossMajor: major ? newestAcrossMajor(parsed, major)?.raw ?? null : null,
            upstreamDigest: null,
            lastCheckedAt: Date.now(),
            lastError: null,
          });
        } else {
          // Digest mode: track manifest digest of the currently-pinned tag,
          // not a hardcoded one — operator could override INFISICAL_IMAGE.
          const pinnedTag = pinned.split(':').slice(1).join(':') || 'latest';
          const digest = await registry.getDigest(CATALOG[image].repo, pinnedTag);
          upsert(db, {
            image, pinnedTag: pinned, newestWithinMajor: null, newestAcrossMajor: null,
            upstreamDigest: digest, lastCheckedAt: Date.now(), lastError: null,
          });
        }
      } catch (err) {
        // Leave last-known versions in place; only update lastError + lastCheckedAt.
        upsert(db, { image, lastError: String(err), lastCheckedAt: Date.now() });
      }
    }
  };

  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    const jittered = POLL_INTERVAL_MS + (Math.random() * 2 - 1) * JITTER_MS;
    timer = setTimeout(async () => { await run(); schedule(); }, jittered);
  };
  void run().finally(schedule);  // fire once at startup
  return () => { if (timer) clearTimeout(timer); };
}
```

Manual refresh (`POST /api/admin/updates/refresh`) runs `run()` once on demand.

### `services/images/env-overrides.ts`

```ts
export function readPin(image: ImageKey): string;
  // Resolution order:
  // 1. compose/.env env-var override (TRAEFIK_IMAGE, POSTGRES_IMAGE, etc.)
  // 2. compose.yml default (parsed once at module load)

export function writePin(image: ImageKey, fullImageRef: string): void;
  // Atomic write: read compose/.env, upsert one line, rename-into-place.
  // Preserves all other keys, comments, and trailing newlines.

export function backupEnv(): string;  // returns the backup file path (.env.bak-${iso})
export function restoreEnv(backupPath: string): void;
export function pruneOldBackups(keep: number): void;  // keep the N most recent
```

### `routes/admin-updates.ts`

```
GET  /api/admin/updates           → AggregatedUpdatesResponse
POST /api/admin/updates/refresh   → 202 Accepted (triggers poller.run())
POST /api/admin/updates/image     → SSE { phase, log, error }
POST /api/admin/updates/agenthub  → existing /api/admin/update aliased here for symmetry
```

`POST .../image` request body:
```ts
type ApplyImageRequest =
  | { image: ImageKey; tag: string; acknowledgedMajor?: boolean }   // semver mode
  | { image: 'infisical'; digestUpdate: true };                     // digest mode
```

Validation rejects:
- unknown `image` keys
- `tag` that isn't `newestWithinMajor`, `newestAcrossMajor`, or `pinnedTag` (idempotent re-apply)
- major-bump (`tag === newestAcrossMajor`) without `acknowledgedMajor: true`
- concurrent applies (shared in-memory `updateLock` with the AgentHub binary path; 409 Conflict)

### Apply flow (server-side orchestration)

```ts
async function applyImageUpdate(req, sse) {
  validate(req);                                         // 1
  assertLockAcquired();                                  // also exclusive with /api/admin/update
  sse.phase('validating');

  const backupPath = backupEnv();                        // 2 (digest mode skips writePin)
  sse.phase('writing-env');
  if (!('digestUpdate' in req)) {
    writePin(req.image, `${CATALOG[req.image].repo}:${req.tag}`);  // 3
  }

  try {
    sse.phase('pulling');
    await streamingDocker(['compose', '-f', composePath, 'pull', service], sse);  // 4
    sse.phase('recreating');
    await streamingDocker(['compose', '-f', composePath, 'up', '-d', '--no-deps', service], sse);  // 5
    sse.phase('done');
    pruneOldBackups(3);
  } catch (err) {
    sse.error(`Apply failed: ${err}. Rolling back.`);
    restoreEnv(backupPath);                              // 6
    try {
      await streamingDocker(['compose', '-f', composePath, 'up', '-d', '--no-deps', service], sse);
      sse.phase('failed');  // old version restored
    } catch (rollbackErr) {
      sse.error(`Rollback also failed: ${rollbackErr}. Manual intervention required. Backup: ${backupPath}`);
      sse.phase('failed');
    }
  } finally {
    releaseLock();
  }
}
```

`--no-deps` is deliberate: recreate just one service. Dependents stay running and reconnect when the service comes back healthy. Brief errors during the recreate window are expected; the confirmation modal warns the operator.

## UI

### Page composition (`pages/admin/Updates.tsx`)

Mirrors the existing admin-page pattern from `pages/admin/InstallBackup.tsx` — no shared `AdminLayout` exists, each admin page renders its own `flex-1 overflow-auto p-6` container:

```tsx
export function UpdatesPage() {
  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-semibold">Updates</h2>
        <p className="text-sm text-zinc-500 mt-1">
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

### `AgentHubPanel.tsx`

Extracted wholesale from `Settings.tsx` lines ~201-450 with no behavior change. The `VersionInfo`/`UpdateProgress` types, `PHASE_RANK`, `UPDATE_TIMEOUT_MS`, `stripAnsi`, the SSE log stream wiring, and the modal connection all move together.

### `ImagePinsTable.tsx`

Reads `/api/admin/updates`, renders one row per image. Columns: image name · current pin · upstream within-major · upstream across-major · action. Actions:

- "Update to X.Y.Z" button when within-major newer is available
- "Update to N.x.x ⚠" with major-bump badge when only across-major is newer (or alongside within-major)
- "—" when on latest
- "Pull new digest" for Infisical when `upstreamDigest !== runningDigest`. The running digest is queried at GET-aggregator time via `docker inspect --format '{{.Image}}' infisical` followed by `docker inspect <imageId> --format '{{index .RepoDigests 0}}'`. Cost: ~50ms per row; acceptable for an admin-only page polled on demand.
- "Manual updates only" badge when `pinnedTag` is unrecognized

Confirmation modal for any apply: lists service name + disruption blurb (`"Recreates Infisical's database briefly. Infisical will fail secret reads for 5-15s while postgres restarts."`). For major bumps: additional checkbox "I understand this is a major version upgrade" gates the action.

While SSE stream is active: modal stays open showing live `phase` + log buffer (same `MAX_LOG_LINES = 200` ring buffer pattern as `AgentHubPanel`). Hide button keeps the stream alive in the background.

## Error handling

| Failure | Caught where | Surface |
|---|---|---|
| Registry HTTP error | `registry-client.ts` | per-row `lastError`; tooltip on the table cell; other rows unaffected |
| Unknown pin format | `pin-policy.ts` classifier | row renders read-only with "Manual updates only" badge |
| `.env` write fails | apply endpoint, pre-pull | SSE `phase: failed`; no rollback needed |
| `docker compose pull` fails | apply endpoint | rollback `.env`, SSE failed |
| `docker compose up -d` fails | apply endpoint | rollback `.env`, re-run `up -d` for old tag, SSE failed |
| Both old + new fail to start | apply endpoint | SSE failed with explicit manual-intervention message + backup path |
| Two simultaneous applies | `updateLock` mutex | 409 Conflict |
| Major bump without ack | apply endpoint validation | 400 Bad Request |
| Poller crashes mid-loop | per-image `try/catch` | only that image's `lastError` populated |

## Testing

### Unit tests (vitest)

| Module | Coverage |
|---|---|
| `pin-policy.test.ts` | Table-driven against ~30 sample tags per image: classify, newestWithinMajor, newestAcrossMajor |
| `registry-client.test.ts` | URL shape, anonymous bearer flow, pagination cursor, 4xx/5xx → thrown error |
| `poller.test.ts` | Upsert success path; per-image error isolation; lastError cleared on next success; digest-mode path; an unrecognized pin → unknown classification |
| `env-overrides.test.ts` | Read order (env > compose default); upsert preserves other keys, comments, trailing newline; backup file naming; pruneOldBackups retains correct N |
| `admin-updates.test.ts` | Endpoint validation (unknown image, unauthorized tag, missing major ack, lock contention); aggregator output shape |
| `compose-pins.test.ts` | New test asserting `compose/docker-compose.yml` resolves to current default tags when env is empty — guards future refactors of the same class as the existing `ports:`-merge test |

### Verification on fresh VM before merge

Per the Phase 1 lesson — ship-blocker bugs surface only on a real VM:

- Poll cycle populates `image_version_cache` for all 4 images
- Page renders with correct upstream-newer badges
- Apply a within-major Traefik bump end-to-end; verify Infisical + agenthub-server stay reachable through the brief restart
- Apply attempt of `newestAcrossMajor` Postgres without the ack-checkbox → 400 surfaced in UI
- Apply major Postgres bump with ack → confirm Infisical recovers, sessions reconnect
- Rollback path: pin Traefik to a deliberately broken tag (e.g., a tag that doesn't exist) → `pull` fails → `.env` reverts → old container resumes
- `agenthub update` with operator pin overrides present: `git pull` succeeds (compose.yml in repo stable), `.env` pins survive, `up -d` honors them
- Both AgentHub binary update and image apply attempted concurrently → second returns 409

## Open questions

None — all axes confirmed during brainstorm:
- Admin-only single page (CLIs stay on Packages)
- Sources: AgentHub binary + container image pins (Docker engine + apt deferred)
- Operator-ahead-of-upstream semantics (registry tag detection, not main-vs-local-compose)
- Pin overrides stored in `compose/.env`
- Major bumps surfaced + labeled, gated by checkbox-ack
- Layout B (AgentHub panel on top, container table below)
- Approach B (clean separation: new `services/images/` paralleling `services/packages/`)

## Out of scope (revisit in later phases)

- Docker engine drift detection — requires host shell access
- Host OS `apt` drift — requires host shell access
- Auto-update on a schedule — explicitly admin-initiated only
- Encrypted `.env` backups — bundle is currently unencrypted (matches install-backup precedent)
- Cross-architecture image digest handling (arm64 vs amd64 manifest lists) — v1 is amd64-only since that's the only platform the install supports today

## References

- Phase 1 spec: `docs/superpowers/specs/2026-05-16-cli-catalog-migration-design.md`
- Phase 1 patterns reused: `packages/server/src/services/packages/poller.ts`, `package_version_cache` table shape
- Existing AgentHub update flow: `packages/server/src/routes/admin.ts` + `packages/web/src/pages/Settings.tsx`
- Compose env-override precedent: `AGENTHUB_SERVER_IMAGE`, `WORKSPACE_IMAGE` already use `${VAR:-default}`
- Access-mode `.env` mutation pattern: `packages/installer/src/lib/access/render-compose.ts`
