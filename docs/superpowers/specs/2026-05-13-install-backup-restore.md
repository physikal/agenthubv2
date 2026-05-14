# Install-state backup + restore

**Date:** 2026-05-13
**Status:** Approved for planning
**Pillar:** #4 (backup + restore-to-new-VM) — slice 4b (install-state bundle)

## Problem

The existing backup feature backs up per-user workspace files (`/home/coder`) to B2, runs inside the workspace container via the agent daemon, and only works when there's an active session. That covers ONE half of "recover this install on a new VM."

The OTHER half — install-level state — is unprotected today:

- `compose/.env` carries `INFISICAL_ENCRYPTION_KEY`, `AGENTHUB_ADMIN_PASSWORD`, `INFISICAL_DB_PASSWORD`, and other secrets generated once at install time. If lost, Infisical's stored data is unreadable even if the Postgres volume itself is intact.
- `/data/agenthub.db` (SQLite) holds users, sessions, `infrastructure_configs` (metadata pointing at Infisical), backup-run history, GitHub-App installations, deployment records. Loss = every user account gone.
- Infisical's Postgres volume (`infisical-pg-data`) holds every user's stored provider secrets — Cloudflare tokens, B2 keys, DO tokens, AI provider API keys. Loss = every user re-enters everything.

**Today's failure mode**: if the operator's VM dies, even a perfect B2 workspace backup is useless — there's no install on the new VM that knows about the users who own those workspaces, no Infisical with their provider keys, and no `.env` with the matching encryption keys to decrypt the (separately backed-up) Infisical Postgres if they had been.

**This spec defines slice 4b**: a single, operator-driven backup of these three artifacts, restorable on a freshly-installed VM such that all users + secrets + history come back. Slice 4b is foundational for the rest of pillar #4 (slices 4a orchestration / 4c pre-session volume restore / 4d OAuth re-pair) but ships standalone — it closes a real "host loss = secrets loss" data-loss bug today.

## Goal

After this PR:

1. Operator can run `agenthub backup-install` (or click "Backup now" in admin UI) at any time. A single `.tar.gz` bundle lands in `/data/install-backups/` and (if configured) in a B2 bucket.
2. `agenthub update` automatically runs a best-effort backup before each update — operators never lose recoverable state to an in-progress update.
3. On a fresh VM, after `./scripts/install.sh` bootstraps an empty stack, the operator can run `agenthub restore-install --from b2://bucket/path/latest --force` to fully reconstitute the prior install: same users, same Infisical secrets, same `infrastructure_configs` mappings, same admin password, same encryption keys. Existing workspace backups (per-user, in B2) then become restorable on first session per existing semantics.
4. The Web UI (Settings → Admin → Install Backup) exposes the same surface: configure B2, view history, trigger backup, validate + run restore.

## Non-goals

- Encryption of the bundle. Operator relies on B2 bucket ACLs (or local-filesystem permissions) for confidentiality. Encryption is an opt-in follow-up (separate spec) — see "Future work" below.
- Per-user install backups. Install state is shared across all users on the install; this is operator-scoped.
- Backing up the per-user workspace files in the same bundle. Slice 4a will compose workspace-restore with install-restore for the full fresh-VM flow. This spec is install-state only.
- Cross-version restore. If `manifest.json` says the bundle was made on a different `BUNDLE_SCHEMA_VERSION`, restore aborts. Forward/backward compatibility comes later if needed.
- Restoring partial state (e.g., "just the users table"). Restore is all-or-nothing per bundle.

## Architecture

### Bundle contents

A single `install-{domain}-{YYYY-MM-DDTHH-mm-ssZ}.tar.gz` containing:

| File | Source | How |
|---|---|---|
| `env` | `compose/.env` | Verbatim file copy |
| `agenthub.db` | `/data/agenthub.db` (SQLite) | `sqlite3 /data/agenthub.db ".backup '/.../agenthub.db'"` — online-safe; SQLite handles locks |
| `infisical.sql` | `infisical-postgres` container | `docker compose exec -T infisical-postgres pg_dump -U infisical -F c -d infisical` — custom format, restore-friendly |
| `manifest.json` | (generated) | `{ schemaVersion: 1, createdAt: ISO8601, sourceDomain, gitSha (from /repo), composeVersion, trigger: "manual"\|"auto-update", note?: string }` |

Tarball filename embeds the source domain so multiple installs can share one B2 bucket without collision (`install-agenthub.physhlab.com-2026-05-13T14-30-00Z.tar.gz`).

Bundle is **unencrypted**. Confidentiality is via B2 bucket ACLs + local filesystem permissions on `/data/install-backups/`. This is a deliberate operator choice — opt-in encryption is a separate spec under "Future work."

### Where it executes

All bundle assembly + restore execution lives in the **server container**. It is the only place with access to all three sources simultaneously:

- `/data/agenthub.db` is already mounted into the server container.
- `/repo` is mounted into the server container (per CLAUDE.md "Repo mount"), giving access to `compose/.env`.
- `/var/run/docker.sock` is mounted (when `PROVISIONER_MODE=docker`), letting the server `docker compose exec` into `infisical-postgres` for `pg_dump`.

The `agenthub` CLI verbs are thin wrappers that invoke endpoints on the running server (`POST /api/admin/install-backup/run` etc.) for manual operations, OR — for `agenthub restore-install` on a freshly-installed VM where the server is up but empty — invoke the same service code via `docker exec agenthub-server node /app/scripts/restore-install.js …`.

If the server container itself is the thing we're restoring (it stops mid-restore), the CLI handles this: it stops the stack with `docker compose stop agenthub-server` (NOT down — Infisical-postgres must stay accessible), runs the restore via a one-shot container (same image, different entrypoint), then brings the stack back up. Details in the CLI section.

### Where the bundle lives temporarily

`/data/install-backups/` on the host, bind-mounted into the server container. Local tarball persists after upload to B2 (fast restore path). Retention prunes oldest beyond the configured "keep last N" (default 10).

### Why not extend the existing per-user backup

The existing backup runs inside the workspace container via the agent. Install state lives on the host, not in any workspace. The two flows share rclone as a tool but not as code paths. Combining them would couple operator-scoped operations (`agenthub` CLI verbs) to per-session WS protocols — wrong abstraction.

### New database schema

Two new tables (Drizzle/SQLite):

```sql
CREATE TABLE install_backup_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),    -- singleton row
  b2_key_id TEXT,
  b2_bucket TEXT,
  b2_path_prefix TEXT DEFAULT 'installs/',
  retention_keep_last INTEGER DEFAULT 10,
  updated_at TEXT NOT NULL
);
-- b2_app_key (the secret) stored in Infisical at /system/install-backup/b2_app_key

CREATE TABLE install_backup_runs (
  id TEXT PRIMARY KEY,                       -- UUID
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,                       -- 'running' | 'ok' | 'failed'
  bytes INTEGER,
  local_path TEXT,
  b2_path TEXT,
  trigger TEXT NOT NULL,                      -- 'manual' | 'auto-update' | 'cli'
  error TEXT,
  note TEXT
);
```

`install_backup_config` is a single-row table (CHECK constraint enforces it). Simpler than a key-value pattern; one well-known PK.

The B2 app key is stored in Infisical under a new system-scoped path (`/system/install-backup/b2_app_key`), not in the SQLite row — same separation pattern as per-user provider credentials. Chicken-and-egg note: this means the FIRST install-backup must be run from an install with a functioning Infisical (always true in practice, since Infisical is bootstrapped during install).

## CLI surface

### `agenthub backup-install`

```
agenthub backup-install [--local-only] [--no-b2] [--note <text>]
```

**Flags**:
- `--local-only`: write the tarball to `/data/install-backups/` only; skip B2 push. Useful for testing.
- `--no-b2`: synonym for `--local-only`.
- `--note <text>`: free-text note stored in `install_backup_runs.note` + `manifest.note`.

**Steps**:
1. Verify B2 configured (unless `--local-only`): read `install_backup_config`; if no B2 config and `--local-only` not set, exit 2 with "no B2 configured; run with --local-only or set up B2 in admin UI."
2. Create staging dir `/data/install-backups/staging-{uuid}/`.
3. Dump SQLite: `sqlite3 /data/agenthub.db ".backup '/data/install-backups/staging-{uuid}/agenthub.db'"`.
4. Dump Infisical Postgres: `docker compose exec -T infisical-postgres pg_dump -U infisical -F c -d infisical > /data/install-backups/staging-{uuid}/infisical.sql`.
5. Copy `.env`: `cp /repo/compose/.env /data/install-backups/staging-{uuid}/env`.
6. Write `manifest.json`.
7. Tar+gzip the staging dir → `/data/install-backups/install-{domain}-{ts}.tar.gz`.
8. Delete staging dir.
9. If B2 configured AND `!--no-b2`: rclone push to `b2://{bucket}/{prefix}install-{domain}-{ts}.tar.gz`.
10. Insert row into `install_backup_runs` with `status='ok'`, paths populated.
11. Prune retention: keep last N runs in both local + B2; delete older tarballs.
12. Print success + paths.

**Exit codes**: 0 ok, 1 backup failed (specific step printed to stderr), 2 misconfig.

**Implementation**: the verb is a thin wrapper that POSTs to `http://localhost:3000/api/admin/install-backup/run` (or via a unix socket if we expose one) using a service-account token. The server container does all the work.

### `agenthub restore-install`

```
agenthub restore-install [--from <local-path-or-b2-url>] [--snapshot latest|<timestamp>] [--force] [--dry-run]
```

**Flags**:
- `--from <path>`: explicit source. Either a local filesystem path (e.g., `/data/install-backups/install-foo.tar.gz`) OR a B2 URL (e.g., `b2://bucket/installs/install-foo.tar.gz`).
- `--snapshot latest`: list B2 objects matching the install-domain prefix, pick the newest. Requires B2 configured in `.env` for credentials.
- `--snapshot <YYYY-MM-DDTHH-mm-ssZ>`: pull a specific timestamp from B2.
- `--force`: bypass conflict check (overwrite non-empty install).
- `--dry-run`: do steps 1-4 (resolve, validate) and print what WOULD happen; exit 0 without touching state.

**Steps**:
1. Resolve source to a local tarball path (pulling from B2 if needed → `/tmp/restore-{uuid}/bundle.tar.gz`).
2. Untar → `/tmp/restore-{uuid}/staging/`.
3. Parse `manifest.json`. If `schemaVersion` ≠ 1, exit 3 ("incompatible bundle schema version").
4. Conflict check (unless `--force`):
   - Refuse if `agenthub.db` has any users.
   - Refuse if Infisical has user secrets stored (count rows in Infisical's `secrets` table > 0).
   - Refuse if there are running workspace sessions (any non-empty `sessions` table with status NOT IN ('destroyed', 'failed')).
   - Refuse if `compose/.env` exists AND its `INFISICAL_ENCRYPTION_KEY` ≠ the bundle's `env` file's value AND Infisical has any data (otherwise restore would write incompatible state).
5. If `--dry-run`: print "would restore N users, M Infisical secrets, sourceDomain=X, gitSha=Y, createdAt=Z" → exit 0.
6. Stop the stack: `docker compose stop agenthub-server agent-workspaces traefik` (NOT infisical-postgres or redis — they're needed for the restore).
7. Replace `compose/.env` with `staging/env`.
8. Replace `/data/agenthub.db` with `staging/agenthub.db` (atomic rename).
9. Run pg_restore: `docker compose exec -T infisical-postgres pg_restore -U infisical -d infisical --clean --if-exists < staging/infisical.sql`.
10. Bring up the stack: `docker compose up -d`.
11. Wait for `/api/health` to return 200 (timeout 60s).
12. Print success + log file path.

**Critical edge — restoring from within the server container that's being restored**:

The server container's running process holds open the SQLite DB and references the `.env` values cached in `process.env` from boot. Restoring those files under the running server is unsafe. So `restore-install` runs in a TEMPORARY container, not the live server:

```bash
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /data:/data \
  -v $(pwd):/repo \
  --network agenthub_default \
  agenthub-server:local \
  node /app/scripts/restore-install.js "$@"
```

The temp container does steps 6-11 (stops the live server, does the swap, brings everything back up). The live server container restarts as part of step 10 (`up -d` recreates it because the underlying `.env` changed).

`--dry-run` does NOT need a temp container — it can run in the live server because steps 1-5 are read-only.

### `agenthub update` integration

`scripts/agenthub update` (existing verb) gains an auto-backup step:

```bash
# After git pull, before image rebuild/recreate:
if ! backup_install_auto; then
  warn "auto-backup failed (continuing update); restore options preserved from previous backup"
fi
```

`backup_install_auto` calls the same backup code path as the manual verb, with `trigger='auto-update'` and a default note `"auto-backup before agenthub update to <new git sha>"`. Failure is non-fatal — the update proceeds.

## Web UI surface

New page: `packages/web/src/pages/admin/InstallBackup.tsx`, mounted at `/admin/install-backup`, sidebar entry under "Admin" (alongside Users).

**Components**:

1. **Last-backup card** (`BackupCard.tsx`): summary of most recent run + "Backup now" button. SSE-streams progress.
2. **B2 destination card** (`B2ConfigCard.tsx`): key ID + (masked) app key + bucket + path prefix inputs. "Save" and "Test" buttons. "Test" calls `POST /api/admin/install-backup/test`.
3. **History table** (`HistoryTable.tsx`): last 50 runs from `install_backup_runs`. Columns: started-at, bytes, status, destinations (Local/B2/both), trigger badge (manual / auto-update), download link (if local file still exists).
4. **Restore card** (`RestoreCard.tsx`):
   - Three source-picker radios: "From a backup in history (select from dropdown)", "Upload a tarball" (file input → POST multipart), "Pull from B2 by timestamp" (text input).
   - "Dry-run validate" button → calls `POST /api/admin/install-backup/restore/validate` → renders the bundle's manifest + conflict report.
   - "Restore" button: disabled until (a) dry-run completed without errors AND (b) operator types the bundle's `sourceDomain` value into a confirmation input. On click: confirmation modal → `POST /api/admin/install-backup/restore/run` with header `Confirm-Restore: yes-i-know-what-this-does` → SSE-streams progress.

**Server endpoints** (`packages/server/src/routes/admin-install-backup.ts`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/install-backup` | B2 config (masked) + last-backup metadata + auto-backup setting |
| PUT | `/api/admin/install-backup` | Save B2 config |
| POST | `/api/admin/install-backup/test` | Test B2 credentials by listing the bucket |
| POST | `/api/admin/install-backup/run` | Trigger backup (SSE progress) |
| GET | `/api/admin/install-backup/runs` | Backup history (last 50) |
| GET | `/api/admin/install-backup/runs/:id/download` | Download local tarball |
| POST | `/api/admin/install-backup/restore/validate` | Resolve + dry-run a source |
| POST | `/api/admin/install-backup/restore/run` | Execute restore (SSE progress) |

Every endpoint is admin-gated by the existing admin-role middleware.

## Conflict-check details

`packages/server/src/services/install-backup/conflict.ts` enforces the "refuse unless --force" rules:

```typescript
interface ConflictReport {
  ok: boolean;
  conflicts: Array<{
    kind: "users-exist" | "secrets-exist" | "active-sessions" | "encryption-key-mismatch";
    detail: string;
  }>;
}

function checkRestoreConflicts(bundle: ParsedBundle): ConflictReport
```

- `users-exist`: `SELECT count(*) FROM users WHERE 1=1` > 0
- `secrets-exist`: query Infisical's `secrets` (or equivalent) table for any rows
- `active-sessions`: `SELECT count(*) FROM sessions WHERE status NOT IN ('destroyed','failed')` > 0
- `encryption-key-mismatch`: parse `bundle.env`'s `INFISICAL_ENCRYPTION_KEY` and compare to current `compose/.env`'s. If they differ AND `secrets-exist`, this is a fatal mismatch.

The Web UI restore card surfaces every conflict with operator-friendly text + the "Refusing — bundle.sourceDomain differs from current install" guidance.

## Retention

`packages/server/src/services/install-backup/retention.ts`:

- `keepLastN` from `install_backup_config.retention_keep_last` (default 10).
- After a successful backup run, list all install-backup tarballs in `/data/install-backups/` AND in the configured B2 bucket; delete oldest beyond N from BOTH.
- The retention pass runs as the last step of `agenthub backup-install` (or `auto-update` backup). It's idempotent — running twice with no new backups is a no-op.

## Auto-backup retention coupling

`trigger='auto-update'` runs are counted under the same retention pool as `manual` runs. If an operator backs up frequently AND updates frequently AND keeps-last-10, automatic runs will dominate the history. That's the expected outcome; manual runs the operator wants to keep can be exported via the download endpoint.

If this turns out to feel wrong in practice, the followup is to add `retention_keep_last_manual` as a separate setting. Out of scope here.

## Testing strategy

**Unit tests** (vitest, target each service file):

- `bundler.test.ts` — fixtures-based: temp dir with known `.env`, sqlite3 db, postgres dump → assert tar contains all four files + manifest valid + tarball extracts cleanly. Mock `docker compose exec` for pg_dump (return a known fixture binary blob).
- `restorer.test.ts` — known bundle → temp compose dir → run restore against isolated fixtures → assert post-state matches expected `.env` contents + sqlite row counts. Mock the actual `docker compose stop / up`; assert the commands the restorer would invoke.
- `conflict.test.ts` — table-driven: empty install (all conflicts pass), install with users (refuses), install with active sessions (refuses), install with encryption-key mismatch (refuses), bypass with `--force=true` (passes regardless).
- `retention.test.ts` — fake filesystem + fake B2 list responses → assert prune behavior for N=1, N=10, edge cases (no backups, exactly N backups).
- `manifest.test.ts` — schema-version-1 round-trip; schema-version-99 parse → assert error.

**Integration test** in `scripts/e2e-full.js`:

After main e2e completes (which leaves a running install with users + a backup-config row + a backed-up workspace):

1. Configure a local-only B2 alternative (or skip B2 push for the e2e).
2. Run `agenthub backup-install --local-only --note 'e2e-test'`. Assert exit 0, tarball appears in `/data/install-backups/`.
3. Run `agenthub restore-install --from <tarball> --dry-run`. Assert exit 0, output contains expected manifest fields.
4. Don't actually restore (too destructive for the shared e2e VM).

The full destructive restore is a manual VM verification, not part of e2e.

**Manual VM verification** (post-merge, before declaring done):

1. **Backup verify** (VM 923 or 924): configure B2 in admin UI, run `agenthub backup-install`, confirm tarball in `/data/install-backups/` + B2.
2. **Round-trip restore on fresh VM**: clone Proxmox 9000 → 925. Run `./scripts/install.sh` to bootstrap empty stack. Run `agenthub restore-install --from b2://bucket/installs/install-VM923-latest.tar.gz`. Verify:
   - All users from VM 923 are present in `/api/users` listing.
   - Logging in as one of those users works with the original password.
   - That user's `infrastructure_configs` are intact (Cloudflare, B2 tokens visible).
   - Creating a workspace session works (Infisical secret-fetch works).

3. **Auto-update verify**: on a running install with B2 configured, run `agenthub update`. Confirm a new `install_backup_runs` row with `trigger='auto-update'`.

## File layout

```
packages/server/src/services/install-backup/
  bundler.ts                // assembles a tarball from current install state
  bundler.test.ts
  restorer.ts                // pulls a tarball apart, applies to running install
  restorer.test.ts
  conflict.ts                // refuse-unless-force checks
  conflict.test.ts
  retention.ts               // prune local + B2 to keep-last-N
  retention.test.ts
  b2-client.ts               // rclone wrapper: push/pull/list/delete
  manifest.ts                // BundleManifest schema + parse/serialize
  manifest.test.ts
  types.ts                   // shared types: BackupRun, RestoreSource, ConflictReport

packages/server/src/routes/admin-install-backup.ts   // 8 endpoints (manual run, restore, config, history, etc.)

packages/server/src/db/schema.ts                      // +2 tables: install_backup_config, install_backup_runs
packages/server/src/db/migrations/NNNN-install-backup.sql

packages/web/src/pages/admin/InstallBackup.tsx       // new admin page
packages/web/src/components/install-backup/
  BackupCard.tsx
  B2ConfigCard.tsx
  HistoryTable.tsx
  RestoreCard.tsx

scripts/agenthub                                      // +2 verbs (backup-install, restore-install)
                                                       // + agenthub update gains auto-backup step
scripts/restore-install.js                            // entrypoint for the temp restore container (sources restorer.ts via require)

docs/operations/install-backup.md                     // operator-facing doc

CLAUDE.md                                              // new "Install backup surface" section under "Architecture decisions"
```

## Future work (true follow-ups, out of scope)

- **Opt-in bundle encryption** (age, GPG, or operator passphrase). Threat model: protects against B2 ACL misconfig + B2 key leak. Adds key-management UX.
- **Slice 4a — restore orchestration UX**: `./scripts/install.sh --restore-from-b2 …` that bootstraps then auto-restores in one step. Composes this slice + slice 4c (pre-session volume restore).
- **Slice 4c — pre-session volume restore**: pre-populate `/home/coder` from per-user B2 backup on first session-create post-restore. Closes the loop for fresh-VM-restore including workspace files.
- **Slice 4d — OAuth re-pairing**: handle Claude Code / Codex CLI auth state on cross-VM restore. Likely partial backup + restore-time re-auth nudge.
- **Scheduled backups (cron)**: operator-configurable schedule beyond "manual + auto-on-update."
- **Separate `retention_keep_last_manual` setting** if auto-update runs end up dominating the pool.
- **Cross-version migration support** if `BUNDLE_SCHEMA_VERSION` needs to grow.

## Risks + open questions

- **`docker compose exec -T infisical-postgres pg_dump` from inside the server container**: requires the server has docker.sock mounted AND knows the compose project name. The compose project name varies (`agenthub-`, `agenthubv2-`, or user-overridden via `COMPOSE_PROJECT_NAME`). Solution: pass it as an env var (already done elsewhere) or detect via `docker inspect` on the server's own container.
- **SQLite `.backup` from the running server**: the server holds a write connection. `.backup` is online-safe in SQLite, but worth verifying it doesn't conflict with WAL mode. (`sqlite3` CLI uses a separate connection.)
- **Restore-in-temp-container needs same network**: the temp container needs to be on `agenthub_default` to reach `infisical-postgres`. Wire via `--network agenthub_default` (compose's default project network).
- **Retention deletion of an in-progress backup tarball**: race if two `backup-install` runs overlap. Mitigation: a `lock` file in `/data/install-backups/` checked at start of backup run; if locked, exit 1 with "another backup is in progress."
- **`compose/.env` line endings / encoding**: must round-trip byte-identical. Use raw file copy (not parse + re-emit) at backup + restore time.
- **The unencrypted-bundle threat model document**: needs explicit prose in `docs/operations/install-backup.md` so operators understand the B2-ACL-only protection model. Without that doc, operators may not realize the risk.

## How to apply

If the next session continues this:

1. Land THIS spec (this PR is docs-only, low risk).
2. Run `superpowers:writing-plans` against this spec to produce `docs/superpowers/plans/2026-05-13-install-backup-restore-impl.md`.
3. Execute the plan on a feature branch `feat/install-backup-restore` per `superpowers:subagent-driven-development`.
4. Manual VM verification (above) before merging.
5. After merge: pillar #4 still has slices 4a, 4c, 4d open. Slice 4c (pre-session volume restore) is the natural next slice — it makes the existing per-user workspace backup also restorable on a fresh VM.
