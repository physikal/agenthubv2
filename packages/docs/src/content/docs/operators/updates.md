---
title: Updates
description: How AgentHub upgrades itself — one code path, two triggers.
---

AgentHub has two ways to trigger an update. They share the same code.

## Trigger 1 — web UI

**Settings → Version panel → Update now** (admin only).

The button is live only when `origin/main` has commits your install doesn't. Pending commits appear above the button so you can see what's coming.

Clicking **Update now** opens a modal that walks through four phases — **Fetching latest code**, **Rebuilding images**, **Restarting server**, **Ready** — with a live elapsed-time counter and a scrollable **Build log** pane streaming the updater container's docker-build output in real time. Under the hood the server spawns a one-shot `agenthubv2-updater:local` container that runs `agenthub update` inside itself; the modal's phase detection combines `/repo` SHA changes with the server process's `serverStartedAt` timestamp so it only flips to "Ready" once the new image is actually serving.

You can hide the modal while the update runs — a banner on the Version card re-opens it. The modal has a 20-minute safety timeout; if a real stall is suspected past that, `agenthub logs` on the host is the next step. When the new server is healthy, a **Reload now** button applies a cache-buster and loads the fresh UI.

Any pending DB migrations run as part of this step.

## Trigger 2 — host shell

```bash
agenthub update
```

Same code path. See [The agenthub CLI](/docs/operators/cli/).

## What each update actually does

1. **Git pull** inside the install's checkout (`/repo` mount in the server container).
2. **Self-update the CLI** if `scripts/agenthub` changed. Re-exec to land it.
3. **`docker compose up -d`** to apply compose-file changes without recreating containers.
4. **`docker build`** any Dockerfile whose source or dependencies changed.
5. **`docker compose up -d --force-recreate agenthub-server`** to swap in the new server image.
6. **DB migrations** run on server boot (Drizzle handles this — it's fast, idempotent, and fails loudly).
7. **Health probe** on `/api/health` for up to 60 seconds.

## What can go wrong

| Symptom | Cause | Fix |
|---|---|---|
| `git pull` fails with merge conflict | You edited files in the install dir | `git stash` or `git reset --hard origin/main` — your data is in volumes, not files |
| Docker build fails | Transient network; disk space; image-base pull error | Re-run — most failures are transient. Check disk with `df -h`. |
| Server won't come healthy | Env var dropped during compose up | Check `agenthub logs agenthub-server` — migrations or SecretStore errors show here |
| "Update now" button doesn't appear | You're not an admin | Ask an admin |

## Upgrade timing

A typical `agenthub update` on a no-source-change release takes **5–10 seconds** (just recreating the server container). A release that rebuilds the server image is **3–8 minutes**, and one that rebuilds both server + workspace images from a cold Docker cache can run **up to 15 minutes**. The progress modal's Build log pane makes it obvious which stage you're in.

The **browser disconnects briefly** during step 5 — the UI shows a "reconnecting..." state and polls `/api/health`. When it comes back, the page auto-reloads so the new frontend bundle is served.

Inside active workspace sessions: your terminal reconnects on its own once the server comes back. ttyd's WebSocket is designed to tolerate transient server drops — your shell in the workspace container is not restarted, your agent's context is preserved.

## Rolling back

If an update breaks something, roll back with git:

```bash
cd <install-dir>
git reset --hard <previous-sha>
agenthub update
```

The update flow is strictly idempotent — running it with an older SHA rebuilds on that older SHA. Data in volumes is unaffected.

**Migrations are generally forward-only**, though — if the new version added a column, rolling back removes it. Plan accordingly before applying a migration to production data.

## Pinning a version

By default `agenthub update` tracks `origin/main`. To pin to a tag:

```bash
cd <install-dir>
git checkout v2.3.1
agenthub update
```

You'll see `agenthub status` show `(not on main)`. The Version panel in the UI will report "pinned to tag v2.3.1, no updates".

To un-pin:

```bash
git checkout main
agenthub update
```

## Forcing a rebuild

`agenthub update` only rebuilds images when Dockerfiles or the paths they copy from have changed. If you need to force a fresh build of everything regardless — e.g. because a base image you pulled is compromised and you want fresh layers:

```bash
cd <install-dir>
docker build --no-cache -f docker/Dockerfile.server -t agenthubv2-server:local .
docker build --no-cache -f docker/Dockerfile.agent-workspace -t agenthubv2-workspace:local .
docker compose -f compose/docker-compose.yml up -d --force-recreate
```
