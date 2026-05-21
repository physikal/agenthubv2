# Unified Ink Installer — Design

**Date:** 2026-05-21
**Status:** Approved (pending spec review)

## Problem

The install has three phases and only the last looks good:

1. `quick-install.sh` (shell) — installs prereqs; raw apt/docker output streams.
2. `install.sh` (shell) — `pnpm install`, build installer, **3 docker image builds** (the noisiest part, `| tail -3`), install CLI.
3. The Ink TUI (`packages/installer`) — prereq checks + config + bringup. Clean, but its **run phase** is just a spinner + the last 8 dimmed log lines — no step list, no progress bars.

Goal: a single, polished installer where the user sees a step list with progress bars (no raw log spam), and the slow docker builds run with live progress.

## Decisions

| # | Decision |
|---|----------|
| 1 | Keep a **minimal shell bootstrap** (the Ink app is Node — something must install Node + build the installer before the TUI can run). Everything visible/slow moves into the TUI. |
| 2 | **Background builds:** start the 3 docker image builds the moment the TUI launches; run config questions concurrently; "Install now" awaits the builds, then continues to bringup. |
| 3 | **Log handling:** all raw output streams to `/tmp/agenthub-install-<ts>.log`; the GUI stays clean; on a step failure show that step's last ~20 lines inline + the full-log path. |
| 4 | Build vs pull is unchanged: build `:local` images by default; skip building any image pinned to a published tag (`AGENTHUB_SERVER_IMAGE`/`AGENTHUB_WORKSPACE_IMAGE`). |

## Phase split

**`install.sh` (bootstrap — trimmed, quiet):**
- Check `pnpm` + `docker` present and daemon reachable (unchanged guards).
- `pnpm install --filter @agenthub/installer...` + build the installer → collapse to `Preparing installer… ✓` (capture verbose output to the install log, not the terminal).
- Install the `agenthub` CLI to `/usr/local/bin` + write `/etc/agenthub/config` (the only `sudo` step — kept in shell to avoid sudo-in-Ink).
- `exec node packages/installer/dist/index.js "$@"`.
- **Removed from `install.sh`:** the 3 `docker build` invocations (server/workspace/updater). They move into the TUI engine.

**Ink TUI (owns everything visible/slow):**
- On launch: start docker image builds in the background (one task per non-pinned image), rendering a build panel with progress bars.
- Concurrently: prereq display + config questions (mode / domain / access-mode / tls / dokploy / admin) — unchanged flow from `app.tsx`.
- On "Install now": await builds (show their progress if still running), then render compose → `docker compose pull` / `up` → Infisical bootstrap → create admin → done screen, as an engine-driven step list.

## Engine + UI separation

A headless **install engine** (no React) runs phases as async **tasks**. Each task has:
`{ id, label, status: "queued"|"running"|"done"|"failed", progress?: { current, total }, error?: string }`.
The engine exposes a subscribe/snapshot interface; the Ink UI re-renders on change. All raw subprocess output for every task is appended to a single log file (`/tmp/agenthub-install-<ts>.log`); the engine keeps an in-memory ring of each task's last ~20 lines for the failure view.

**Components:**
- `lib/engine/log-file.ts` — open the timestamped log file; `appendTaskLine(taskId, line)` writes to file + updates the per-task ring buffer.
- `lib/engine/buildkit-parse.ts` — pure function: given a `docker build --progress=plain` stderr line, return `{ step, total } | null` by matching BuildKit's `#N [x/y] …` step markers. Tracks the max `total` seen and the highest `x` to drive the bar.
- `lib/engine/docker-build.ts` — `buildImage({ tag, dockerfile, gitSha, onProgress, onLine })`: spawn `docker build --progress=plain --build-arg GIT_SHA=… -f <dockerfile> -t <tag> .`, feed stderr lines to `buildkit-parse` → `onProgress`, and every line to `onLine` (→ log file). Resolves on exit 0, rejects with the tail on non-zero.
- `lib/engine/task.ts` — a small task store: `createTask`, `setStatus`, `setProgress`, `snapshot()`, `subscribe(cb)`. No React.

**Build inputs:** the TUI computes `GIT_SHA` via `git rev-parse HEAD`. Images + Dockerfiles:
- `agenthubv2-server:local` ← `docker/Dockerfile.server` (skip if `AGENTHUB_SERVER_IMAGE` is a non-`:local` tag)
- `agenthubv2-workspace:local` ← `docker/Dockerfile.agent-workspace` (skip if `AGENTHUB_WORKSPACE_IMAGE` pinned)
- `agenthubv2-updater:local` ← `docker/Dockerfile.updater` (always)

## Layout

While configuring (builds running in background):
```
  AgentHub v2 installer

  Setup                                Building images
  ───────────────────────────         ─────────────────────────────────────
  ✓ mode      local docker            ✓ server     ███████████████  done
  ✓ domain    localhost               ⠋ workspace  █████████░░░░░░  62%  [7/11]
  ▸ Admin password (blank = random)   · updater    queued
    > ••••••••

  prereqs ✓     logs → /tmp/agenthub-install-<ts>.log
```

After "Install now" → bringup:
```
  ✓ Build images        done
  ⠋ Start services      ████████░░░░  pulling postgres, redis, traefik…
  · Bootstrap Infisical  queued
  · Create admin         queued

  logs → /tmp/agenthub-install-<ts>.log
```

On failure (only time raw output surfaces):
```
  ✗ Build server image — failed (exit 1)
    …last ~20 lines of the step log…
  Full log: /tmp/agenthub-install-<ts>.log
```

## UI components

- `components/ProgressBar.tsx` — renders `████░░░░ 62%  [7/11]` from `progress?: {current,total}`; indeterminate (spinner) when no total.
- `components/StepList.tsx` — renders an array of tasks with status glyph (`✓ ⠋ · ✗`) + label + optional ProgressBar.
- `components/BuildPanel.tsx` — the right-hand "Building images" panel (a StepList over the build tasks).
- `app.tsx` — start builds on mount via the engine; render config (existing steps) with `BuildPanel` beside it; the `run` step renders a `StepList` over the bringup tasks; a `FailureView` shows the failed task's tail + log path.

## Error handling

- Any task rejection → that task `failed` with the captured tail; the UI switches to the FailureView; process exits non-zero (preserve existing exit codes: 3 = install failure).
- A background build that fails while the user is still configuring marks the build task `failed` in the panel; "Install now" is blocked with a clear message pointing at the log.
- The install log path is always printed (success and failure) so it's discoverable.

## Non-goals

- No build-vs-pull release-model change (separate effort).
- No verbose/live-log toggle (decided: capture-to-file + failure tail).
- No change to the config questions / flow themselves — only the run/build presentation.
- `quick-install.sh` prereq phase keeps its current `step`/`ok` shell narration (it runs before Node exists; out of scope to GUI-ify).

## Testing

- **Unit (vitest, installer package):** `buildkit-parse` (sample `--progress=plain` lines → `{step,total}`, and non-matching lines → null); `task.ts` store (queued→running→done/failed, progress updates, subscribe fires); `log-file.ts` (writes lines, ring buffer keeps last N).
- **Manual (live VM):** full one-liner install — builds show progress while configuring; bringup step list; induced failure (e.g. break a Dockerfile) shows the tail + log path.
- Ink components have no test harness in this package today; they're verified manually.

## Open items to confirm during planning

- Exact BuildKit `--progress=plain` line format on the target Docker version (29.x) — verify the `#N [x/y]` marker shape against real output before finalizing the parser regex.
- Whether `app.tsx`'s concurrent "builds running while interactive prompts accept input" causes Ink re-render/focus issues — validate early; fall back to a non-blocking timer-driven snapshot poll if subscribe-driven re-render fights TextInput focus.
