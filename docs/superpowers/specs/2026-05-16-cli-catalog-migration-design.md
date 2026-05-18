# CLI Catalog Migration (Phase 1 of CLI-freshness roadmap)

**Status:** Design
**Date:** 2026-05-16
**Owner:** boodyjenkins@gmail.com

## Problem

Coding-agent CLIs (`claude-code`, `opencode`, `codex`, `mmx`) ship updates frequently — sometimes weekly. Today they're baked into the workspace image via `npm install -g …` at build time, which means their freshness is coupled to the AgentHub release cadence. A user on AgentHub v0.4 today is running last month's `claude-code`, even though Anthropic shipped four versions since.

We also have a `gh` wrapper at `/usr/local/bin/gh` (`docker/gh-agenthub-wrapper.sh`) that auto-mints GitHub App installation tokens for every `gh` call. PR #90 (agent-CLI auth integration) added a guided OAuth flow for the GitHub CLI from the Integrations page — the wrapper is now redundant for users who Connect via the UI.

This phase is the foundation for the broader CLI-freshness roadmap (5 phases total — Updates page, Sandcastle integration, Runs page, multi-provider comparison). Everything downstream assumes CLIs live in the per-user volume with first-class update tracking.

## Goals

- Workspace image stops being the source of truth for the npm-installable coding-agent CLIs
- New install lands in `~/.local/bin/<cli>`, persisted across sessions via the per-user volume
- Sensible defaults: new users get `claude-code`, `opencode`, `codex` auto-installed on first session
- "Update available: X → Y" badge in the Packages page, sourced from a periodic server-side poll
- Per-tool one-click Update button
- Workspace image shrinks; build time drops (fewer RUN layers, smaller npm cache)

## Non-goals (for this phase)

- gh-wrapper redesign + moving `gh` into the catalog. Deferred to a later phase (probably between Phase 2 Updates page and Phase 3 Sandcastle integration). `gh` stays apt-installed in the image, sans wrapper.
- Aggregate "Update all" button. The (Phase 2) Updates page is where that surface belongs.
- Auto-update on a schedule. Surface "available," let user click. Auto-update is a separate opinion-heavy choice that can land later if anyone asks.
- Multi-arch CLIs (ARM64 / Pi). Separate effort.
- Migration helper that auto-runs `gh auth login` for existing GitHub App users on workspace rebuild. Release notes surface the one-time prompt; users Connect via Integrations.

## Architecture

Five layers change; each has clear boundaries.

```
┌──────────────────────────────────────────────────────────┐
│  Web UI — Packages page                                  │
│   • Card shows installedVersion + latestVersion          │
│   • Yellow "Update available" badge when divergent       │
│   • Update button → SSE-streamed install                 │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼  GET /api/packages
┌──────────────────────────────────────────────────────────┐
│  Server                                                  │
│   • Catalog: 3 entries marked essential                  │
│   • Version-check poller: 30-min npm-registry sweep      │
│   • package_version_cache table                          │
│   • SessionManager fires essentials.ensure on active     │
└──────────────────────────────────────────────────────────┘
                          │  WS (existing)
                          ▼
┌──────────────────────────────────────────────────────────┐
│  Agent daemon (in workspace)                             │
│   • essentials.ensure handler                            │
│   • For each missing binName in ~/.local/bin:            │
│       package-ops.installPackage()                       │
│   • Streams output to terminal scrollback                │
└──────────────────────────────────────────────────────────┘
```

### Workspace image (`docker/Dockerfile.agent-workspace`)

Remove:

```dockerfile
RUN npm install -g \
      @anthropic-ai/claude-code \
      opencode-ai \
      mmx-cli \
    && npm cache clean --force
```

Remove the wrapper bits:

```dockerfile
COPY docker/gh-agenthub-wrapper.sh /usr/local/bin/gh
RUN chmod 0755 /usr/local/bin/gh
```

Delete `docker/gh-agenthub-wrapper.sh` from the repo entirely.

Keep `gh` via the existing apt install (lines 60-65) — it's a plain `gh` binary now, no wrapper.

Also keep the MiniMax shim (`docker/claude-minimax-wrapper.sh` → `/usr/local/bin/claude-minimax`) because it depends on a `claude` binary being available system-wide. **But** since we're removing the system-wide `claude` install, this needs adjustment: the shim should `exec ~/.local/bin/claude` (the catalog-installed version) instead of just `claude`. One-line change in the shim.

### Catalog (`packages/server/src/services/packages/catalog.ts`)

Schema additions:

```ts
export interface PackageManifest {
  // ...existing fields...
  /** Auto-installed by the agent daemon on session-active if missing. */
  essential?: boolean;
}
```

Entry diffs:

```ts
{
  id: "claude-code",
  // remove: isBuiltin: true,
  essential: true,
  // ...rest unchanged
},
{
  id: "opencode",
  // remove: isBuiltin: true,
  essential: true,
  // ...rest unchanged
},
{
  id: "minimax",
  // remove: isBuiltin: true,
  // no essential flag — opt-in only
  // ...rest unchanged
},
{
  id: "codex",
  // ...existing — add essential: true
  essential: true,
},
{
  id: "droid",
  // ...unchanged — opt-in via curl-sh
},
```

After this, no entry has `isBuiltin: true`. The Packages UI's "Preinstalled" badge logic disappears (or stays for `gh` if we ever decide to surface it in the catalog as informational-only — out of scope here).

### Database (`packages/server/src/db/schema.ts` + `db/index.ts`)

New table:

```ts
export const packageVersionCache = sqliteTable("package_version_cache", {
  packageId: text("package_id").primaryKey(),
  latestVersion: text("latest_version"),
  checkedAt: integer("checked_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  error: text("error"),
});
```

DDL in `initDb()`:

```sql
CREATE TABLE IF NOT EXISTS package_version_cache (
  package_id TEXT PRIMARY KEY,
  latest_version TEXT,
  checked_at INTEGER NOT NULL,
  error TEXT
);
```

No FK — package IDs are catalog-local strings, not user-scoped.

### Server: version-check (`packages/server/src/services/packages/version-check.ts`)

```ts
export async function checkVersion(spec: InstallSpec): Promise<{ latest: string } | { error: string }> {
  if (spec.method === "npm") {
    return checkNpm(spec.npmPackage);
  }
  if (spec.method === "github-release") {
    // Reserved for future. Phase 1 has no tools that use this method.
    return { error: "github-release version check not implemented" };
  }
  // curl-sh, binary: no reliable upstream version source; treat as "unknown"
  return { error: "no version source for install method" };
}

async function checkNpm(pkg: string): Promise<{ latest: string } | { error: string }> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return { error: `npm ${pkg}: HTTP ${res.status}` };
  const body = await res.json() as { version?: string };
  if (!body.version) return { error: `npm ${pkg}: no version in response` };
  return { latest: body.version };
}
```

### Server: poller (`packages/server/src/services/packages/poller.ts`)

```ts
export class VersionPoller {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly intervalMs = 30 * 60 * 1000) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    for (const manifest of listCatalog()) {
      const result = await checkVersion(manifest.install);
      const now = new Date();
      if ("latest" in result) {
        await db.insert(packageVersionCache)
          .values({ packageId: manifest.id, latestVersion: result.latest, checkedAt: now })
          .onConflictDoUpdate({ target: packageVersionCache.packageId,
            set: { latestVersion: result.latest, checkedAt: now, error: null } });
      } else {
        await db.insert(packageVersionCache)
          .values({ packageId: manifest.id, checkedAt: now, error: result.error })
          .onConflictDoUpdate({ target: packageVersionCache.packageId,
            set: { checkedAt: now, error: result.error } });
      }
    }
  }
}
```

Started from `packages/server/src/index.ts` after DB init.

### Server: GET /api/packages extension

Existing handler returns `{ catalog, installed }`. Extend to join cache:

```ts
{
  id: "claude-code",
  name: "Claude Code",
  description: "...",
  installedVersion: "1.0.40",      // existing (daemon-reported)
  latestVersion: "1.0.43",          // NEW from cache
  updateAvailable: true,            // NEW (semver compare)
  versionCheckedAt: "2026-05-16T..", // NEW (cache.checked_at)
  // ...
}
```

`updateAvailable` is computed server-side via semver comparison (`semver` is already a transitive dep via npm tooling; or use a hand-rolled compare since version strings are well-behaved here).

### Agent daemon: essentials installer (`packages/agent/src/essentials.ts`)

```ts
export interface EssentialSpec {
  packageId: string;
  binName: string;
  install: InstallSpec;
}

export async function ensureEssentials(
  specs: EssentialSpec[],
  log: (line: string) => void,
): Promise<void> {
  const { access } = await import("node:fs/promises");
  const localBin = "/home/coder/.local/bin";
  const missing: EssentialSpec[] = [];
  for (const s of specs) {
    try {
      await access(`${localBin}/${s.binName}`);
    } catch {
      missing.push(s);
    }
  }
  if (missing.length === 0) return;
  log(`[essentials] installing: ${missing.map((m) => m.packageId).join(", ")}`);
  await Promise.all(missing.map((s) => installOne(s, log)));
  log(`[essentials] done`);
}

async function installOne(spec: EssentialSpec, log: (l: string) => void): Promise<void> {
  // Delegate to existing package-ops.installPackage — same code path as the
  // user-clicked install button.
  try {
    await installPackage({ packageId: spec.packageId, install: spec.install, binName: spec.binName });
    log(`[essentials] ${spec.packageId} installed`);
  } catch (err) {
    log(`[essentials] ${spec.packageId} failed: ${(err as Error).message}`);
  }
}
```

### Daemon WS: new message

Add to `AuthInbound`-style protocol (or a separate protocol file for non-auth concerns):

```ts
| { type: "essentials.ensure"; specs: EssentialSpec[] }
```

`ws-server.ts`'s `handleMessage` dispatches `essentials.*` messages to a new `EssentialsHandler` (parallel to the `AuthHandler` pattern from PR #90).

Output streams over the existing terminal-scrollback path (so user sees install progress when they open the terminal) — the daemon writes to a shared log stream that ttyd buffers.

### SessionManager hook

In `provisionAndStart`, after the `status: "active"` update, alongside the existing `hydrateCredentialsForSession` call, add:

```ts
if (session.userId && session.purpose === "user") {
  void this.ensureEssentialsForSession(session.id);
}
```

Implementation:

```ts
private async ensureEssentialsForSession(sessionId: string): Promise<void> {
  const entry = this.agents.get(sessionId);
  if (!entry) return;
  const specs = listCatalog()
    .filter((m) => m.essential === true)
    .map((m) => ({ packageId: m.id, binName: m.binName, install: m.install }));
  entry.ws.send(JSON.stringify({ type: "essentials.ensure", specs }));
}
```

Fire-and-forget. Failures are non-fatal — user gets a non-essentialed session and can manually install via Packages.

### Web UI (`packages/web/src/pages/Packages.tsx`)

Card extension:

- When `latestVersion > installedVersion`: yellow badge "Update available — 1.0.40 → 1.0.43" (use Tailwind `bg-yellow-500/10 border-yellow-500/30 text-yellow-200`)
- Replace "Remove" button with "Update" when update available (with secondary "Remove" via overflow menu)
- Footnote "Last checked X min ago" tied to `versionCheckedAt`

Update flow: reuse the existing install endpoint (`POST /api/packages/install`) which already handles the per-user volume install. Same SSE-streamed log output. The install just overwrites the binary — npm's `-g --prefix ~/.local` semantics handle this naturally.

### MiniMax shim adjustment

`docker/claude-minimax-wrapper.sh` currently calls `claude` from PATH. Since the system-wide `claude` install is going away, change the resolution:

```bash
# Resolve claude binary — prefer per-user install, fall back to PATH lookup
CLAUDE_BIN="${HOME}/.local/bin/claude"
if [ ! -x "$CLAUDE_BIN" ]; then
  CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
fi
if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
  echo "claude-minimax: claude CLI is not installed in this workspace." >&2
  exit 1
fi
exec "$CLAUDE_BIN" "$@"
```

This means `claude-minimax` works only after `claude` is installed via the essentials auto-install (always, for new sessions) or manual install (existing volumes get it on next session-active).

## Error handling

| Scenario | Behavior |
|---|---|
| npm registry is down during poller tick | Cache row keeps last-good `latest_version`; `error` column records the HTTP error; UI shows "last check failed: …" tooltip beside the "Last checked X min ago" text |
| Auto-install fails for an essential | Daemon logs the error to terminal scrollback; session is still `active`; user can manually install via Packages |
| User clicks Update during their own active session that has the CLI running | npm overwrites the binary; running process keeps its old version in memory until exit. Next CLI invocation picks up the new one. No interruption. |
| Daemon crashes mid-install of essentials | Re-runs the check on next session-active; missing binaries get retried |
| User deletes `~/.local/bin/claude` from terminal | Next session-active sees the binary missing and reinstalls it — idempotent |
| Catalog adds a new essential in a future AgentHub release | Existing user volumes don't have it; next session-active installs it (the daemon already iterates over the current essentials list, not a stored snapshot) |

## Migration impact

**New installs (post-this-PR):** First session takes ~30-60s longer than before because three npm installs run in parallel before the user can effectively use claude/opencode/codex. The terminal is usable immediately; user can watch install progress in the terminal scrollback or just wait.

**Existing user volumes:** Already have `claude`, `opencode`, `mmx` at `/usr/bin/*` (from the image). After this PR, the image no longer provides them. Existing user's next session:
- Image rebuilds — `/usr/bin/claude` is gone
- Session-active fires essentials check — `~/.local/bin/claude` is also gone (it was a system binary, not a user install)
- Daemon installs into `~/.local/bin` — user has claude back, freshest version, on first new session
- Net: one session of "first time" feel; subsequent sessions are normal

**Existing user volumes with `~/.local/bin/claude` already installed manually:** Their version is used; the essentials check sees it exists and skips. They use their manually-installed version until they click Update.

**`gh` wrapper removal:** Existing users relying on auto-tokenized gh see "not authenticated" on first `gh` call. They're directed to Integrations → Connect on GitHub CLI (the new feature). One-time, ~30 seconds. Release notes call this out prominently.

## File layout

```
packages/server/src/services/packages/
├── catalog.ts                # essential flag + entries adjusted
├── version-check.ts          # NEW — npm-registry + future github-release dispatch
├── version-check.test.ts     # NEW — parser + error-mode unit tests
├── poller.ts                 # NEW — 30-min scheduled tick
├── poller.test.ts            # NEW — schedule + idempotency unit tests
└── (existing files unchanged)

packages/server/src/db/
├── schema.ts                 # add packageVersionCache table
└── index.ts                  # add CREATE TABLE

packages/server/src/services/session-manager.ts
   # add ensureEssentialsForSession() + post-active call

packages/server/src/index.ts
   # boot VersionPoller after initDb

packages/server/src/routes/packages.ts
   # extend GET /api/packages with cache join, returning latestVersion/updateAvailable

packages/agent/src/
├── essentials.ts             # NEW — ensureEssentials() routine
├── essentials.test.ts        # NEW — idempotency, parallelism
└── ws-server.ts              # extend with EssentialsHandler dispatch

packages/agent/src/packages-protocol.ts
   # NEW — non-auth daemon WS message types. The essentials.ensure
   # message goes here, not in auth/protocol.ts (different subsystem,
   # different lifecycle). Pattern mirrors auth/protocol.ts.

packages/agent/src/ws-server.ts
   # extend InboundMessage union with the new packages-protocol types;
   # add a setPackagesRouter() parallel to setAuthRouter()

packages/web/src/pages/Packages.tsx
   # Card: installed/latest version, badge, Update button

docker/Dockerfile.agent-workspace
   # Remove: npm install -g (claude-code, opencode, mmx-cli)
   # Remove: COPY gh-agenthub-wrapper.sh + chmod

docker/gh-agenthub-wrapper.sh
   # DELETE — replaced by agent-auth Connect flow

docker/claude-minimax-wrapper.sh
   # Adjust: prefer ~/.local/bin/claude over PATH
```

## Testing strategy

### Unit (vitest)

- `version-check.test.ts` — npm registry response parsing (success, missing version field, HTTP error, network timeout)
- `poller.test.ts` — `tick()` writes upserts correctly for both success and error paths; `start()` schedules at the configured interval
- `essentials.test.ts` — `ensureEssentials` is idempotent (mocked fs.access + mocked install fn); installs only missing entries; reports per-package failures without aborting siblings
- `catalog.test.ts` (extend) — entries with `essential: true` are exactly the expected set

### Integration

- `packages/server/test/integration/packages-poller.test.ts` — VersionPoller against a stubbed npm registry; verifies cache rows end up correct
- `packages/agent/src/auth/integration.test.ts` (pattern) — `ensureEssentials` against the fake CLI fixture: stub install fn returns success, idempotent re-run is a no-op

### Manual on a fresh VM

- One-liner install from main
- Session create → confirm terminal shows essentials install progress in scrollback
- After ~30s, `which claude && claude --version` works (from `~/.local/bin`)
- `gh auth status` says "not authenticated" (wrapper gone — expected); Integrations → Connect on GitHub CLI; `gh auth status` now reports authenticated
- Bump a catalog entry's `latestVersion` cache manually via SQL; reload Packages page; verify "Update available" badge appears

## Spec self-review

After writing this doc:

1. **Placeholder scan:** No "TBD" or "TODO" outside the explicit "Reserved for future" note in `checkVersion`'s github-release branch (intentional — first use case is a future phase).
2. **Internal consistency:** Catalog's `essential` flag is used by SessionManager (`filter((m) => m.essential === true)`) and surfaces correctly in the daemon-side `ensureEssentials` call. MiniMax shim adjustment is consistent with claude moving out of system PATH.
3. **Scope:** Single phase. ~5 new files, ~6 modified, two file deletions. Reasonable for one implementation plan.
4. **Ambiguity:** "Essential" set is explicit (claude-code, opencode, codex). "Auto-install" trigger is precisely defined ("after status: active for purpose === 'user' sessions"). Update UX is fully described.

## What this design explicitly rejects

- **Tracking per-user "essentials installed" flag in DB.** Rejected because idempotent check at session-active is simpler and self-healing (handles user-deletes-binary case automatically).
- **Auto-update on a schedule.** Rejected for Phase 1 because update is a user-action surface — auto-update is a separate opinion. Easy to add later if users ask.
- **Migration helper that auto-runs `gh auth login`.** Rejected because the new agent-auth Connect flow is the canonical answer; surfacing it in release notes is enough.
- **Multi-source version checks** (npm + GitHub Releases for the same package). Reject — every catalog entry has one canonical install method; the version source matches that method.
- **Removing `mmx` and `droid` from the catalog.** They stay as opt-in installable entries; only `essential` flag changes.
