# Unified Workspace Backup — Design

**Date:** 2026-05-20
**Status:** Approved (pending spec review)

## Problem

AgentHub has three overlapping backup mechanisms, and workspace files
(`/home/coder` — the projects users build) fall through the cracks:

1. **Install/platform backup** (`agenthub backup-install`; Settings → Admin;
   auto-runs before every `agenthub update`) — `compose/.env` + `/data/agenthub.db`
   + Infisical Postgres dump. **Excludes `/home/coder` by design.**
2. **Per-user workspace backup** (Backups page → agent rclone) — syncs
   `/home/coder` to the *user's own* B2, **requires an active session**,
   excludes `node_modules`/`.cache`/`.local`.
3. **Operator workspace backup** (`agenthub backup-workspace`) — full volume
   snapshot of `agenthub-home-{userId}` to the *operator's* B2. **CLI-only**,
   no web UI, no automatic trigger. (`runWorkspaceBackup` has zero callers
   outside `scripts/agenthub`.)

Net effect: the prominent, automatic backup never includes workspace files,
and the one that does is manual/CLI-only and duplicated by a session-bound
rclone path. Users reasonably assume "backups" cover their work; they don't.

## Decisions

| # | Decision |
|---|----------|
| 1 | Keep the install/platform backup as its own operator-DR feature. Unify only the two `/home/coder` paths into one. |
| 2 | Build the single workspace backup on the **sidecar volume-snapshot** engine → operator B2. Remove the per-user agent-rclone / per-user-B2 path. |
| 3 | Automatic trigger: **before every `agenthub update`, all users, best-effort** (a per-user failure logs but does not abort the update). Plus manual triggers. |
| 4 | Snapshot contents: **everything under `/home/coder` except `node_modules`, `.cache`, `.local`** (the agenthub CLI tree, auto-reinstalled on session boot). |
| 5 | **Admin** manages backups (any/all users, history, restore); **regular users** get a "back up my workspace now" button. |
| 6 | **B2 optional, local-first.** Always write a local bundle; push to operator B2 only when configured. Add **download** of local bundles. |
| 7 | **Restore is a first-class deliverable** for every source, and verified by an E2E round-trip. |

## The model (after)

Two backups remain:

- **Install/platform backup** — unchanged.
- **Workspace backup** — one mechanism: sidecar volume snapshot →
  `/data/workspace-backups/{userId}/workspace-{userId}-{ts}.tar.zst` (local),
  pushed to operator B2 under `workspaces/{userId}/` when configured.
  Manual (admin: any/all; user: own) + automatic (pre-update, all users,
  best-effort). Excludes `node_modules`, `.cache`, `.local`.

## Server

### Engine (reuse — already built)
`packages/server/src/services/workspace-backup/{bundler,restorer,runner,manifest,volume,types}.ts`.

Edits:
- **Excludes:** add `node_modules` (anywhere) + top-level `.cache`/`.local`
  to the sidecar tar in `bundler.ts` (the `tar -rf … -C /src .` step).
- **Retention:** reuse `install-backup/retention.ts` (`pruneLocal`, `pruneB2`,
  `pickFilesToDelete`, `parseFilenameTimestamp`). Prune per-user
  (`/data/workspace-backups/{userId}/` locally; `workspaces/{userId}/` in B2).
  `keepLast` default 10, operator-configurable.

### B2
Reuse install-backup's `loadB2Config()` (operator B2). `runWorkspaceBackup`
already nests bundles under `workspaces/{userId}/`. `b2 = null` → local-only
(complete bundle still produced).

### Routes
- **New admin app** `routes/admin-workspace-backup.ts` → mounted at
  `/api/admin/workspace-backup` (next to install-backup in `index.ts`),
  behind `adminMiddleware`:
  - `GET /` / `GET /users/:id` — history (all / by user).
  - `POST /run` (one user or `all`) — SSE-streamed.
  - `POST /restore/run` — SSE-streamed; sources: B2 snapshot (`latest`|named),
    local on-disk bundle, uploaded file. Keeps the existing active-session guard.
  - `GET /download/:userId/:filename` — stream a local bundle.
  - `POST /prune` (or fold into run).
- **Per-user endpoints** (auth, scoped to own `user.id`):
  - `POST /api/user/workspace-backup/run` — back up own workspace now.
  - `GET /api/user/workspace-backup` — own snapshot history.
  - `GET /api/user/workspace-backup/download/:filename` — download own bundle.
  - `POST /api/user/workspace-backup/restore` — restore own workspace from own
    snapshot/upload; the active-session guard forces the user to end sessions
    first; destructive-confirm required.

### Pre-update hook
In `scripts/agenthub` `cmd_update`'s best-effort `auto_backup` (which already
calls `cmd_backup_install`), add a best-effort `backup-workspace --all`.
Per-user failures log and continue. Covers CLI **and** web-UI updates (the
updater container runs the same CLI). Note: adds time/size to updates.

### History
Repurpose the now-freed `backup_runs` table (already `user_id` +
`started_at`-keyed). Adjust columns as needed (bundle path, B2 path, trigger,
bytes, status, error).

### CLI
`agenthub backup-workspace` / `restore-workspace` already exist (incl.
`--all`, `--local-only`, `--from`, `--snapshot`, `--force`). Keep; wire
`--all` into the pre-update path.

## Removals (replace, don't deprecate)

- **Agent** (`packages/agent/src/ws-server.ts`): delete `handleBackup` rclone
  path, `BackupParams`, `validateBackupParams`, and `{type:"backup"}` handling.
- **Server**: delete `backupViaAgent` (`session-manager.ts`); the per-user
  backup routes in `routes/user.ts` (`/backup`, `/backup/save|restore|status`,
  config get/set/delete); `toAgentParams`; per-user B2 backup-config helpers.
- **Web**: rework the Backups page (below).

## UI

- **Backups page (all users):** "Back up my workspace now" button; list of my
  snapshots (timestamp, size) with Download + Restore (destructive-confirm,
  "end your sessions first" hint).
- **Settings → Admin → Workspace Backup (admin):** mirrors the Install Backup
  card. Per-user rows (last-backup time/size), "Back up" per row + "Back up
  all", history, Download, Restore (from B2 snapshot / local / upload, with
  active-session guard surfaced), `keepLast` retention setting. For very large
  cross-VM transfers the UI notes the CLI `--from` + scp path.

## Testing

- **Unit:** sidecar exclude args; per-user retention pruning; route auth
  scoping (user → own only, admin → any); restore source selection; the
  active-session guard rejecting restore over a live session.
- **E2E round-trip (the "it works" proof):** seed files in `/home/coder` →
  back up → wipe the volume → restore → assert files are back AND excluded
  `node_modules` is absent. Also exercise: local-only backup + download +
  upload-restore; B2 snapshot restore.
- **Smoke:** confirm existing install-backup restore still works in the same pass.

## Open items to confirm during planning

- The per-user `provider='b2'` infra row: confirm it has no consumer other
  than the removed per-user backup path (and that install-backup's
  `loadB2Config()` reads a *separate* config row, so removal is safe).
- `backup_runs` column shape vs. what workspace history needs.
- Upload-restore handling for multi-GB files (multipart stream → temp →
  restore; document the CLI as the lighter cross-VM path).
