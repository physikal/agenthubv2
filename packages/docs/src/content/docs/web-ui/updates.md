---
title: Updates
description: Admin-only page for upgrading the bundled stack images — Traefik, Postgres, Redis, Infisical.
---

**Updates** is an admin-only page at `/admin/updates` (it sits behind the same admin gate as the Users page). It surfaces upgrade availability for the four bundled stack images and applies updates one service at a time.

This is the **image / stack updater**. It's a different thing from `agenthub update`, which upgrades the AgentHub application binary and its `:local` images. The Updates page also embeds a small panel for that AgentHub binary update — see [Updates (CLI binary self-update)](/docs/operators/updates/) — but its main job is the stack-image table below.

## The four images

| Image | Compose service | Default pin |
|---|---|---|
| Traefik | `traefik` | `traefik:v3.6` |
| Postgres (Infisical's DB) | `infisical-postgres` | `postgres:16-alpine` |
| Redis (Infisical's cache) | `infisical-redis` | `redis:7-alpine` |
| Infisical | `infisical` | `infisical/infisical:latest-postgres` |

These are Infisical's data layer plus the reverse proxy — not the AgentHub server itself, which `agenthub update` owns.

## Pins are env-overridable

Each image's tag is pinned in `compose/.env` via an env var, defaulting to the catalog value above:

```
TRAEFIK_IMAGE=traefik:v3.6
POSTGRES_IMAGE=postgres:16-alpine
REDIS_IMAGE=redis:7-alpine
INFISICAL_IMAGE=infisical/infisical:latest-postgres
```

You can hand-edit these in `.env` and `agenthub restart` — but the Updates page is the supported path, because it pulls, validates, and recreates for you.

## What the table shows

A 30-minute Docker Hub poller writes each image's available tags into an `image_version_cache` table. The page reads that cache and shows, per image:

- **Pinned** — the tag currently in `.env` (or the catalog default).
- **Within-major** — the newest tag inside the current major line (e.g. `v3.6` → a newer `v3.x`). Safe upgrade.
- **Major bump** — the newest tag across major versions (e.g. postgres `16` → `18`). Flagged with a warning.
- An **Update** button when something newer is available.

Infisical is pinned to a floating tag (`latest-postgres`), so it's tracked by **digest** rather than semver: the page shows whether the upstream digest differs from what you're running and offers a **Pull new digest** button.

## Applying an update

Click the per-image Update button. A confirmation modal shows the current tag, the target tag, and a one-line description of the disruption (e.g. "Restarts Infisical's database; secret reads fail for 5-15s"). Confirm, and the apply streams its phases over SSE into a live log pane:

1. **validating** — re-checks the target tag is one the poller offered.
2. **writing-env** — writes the new pin into `compose/.env` (backing up the old `.env` first).
3. **pulling** — `docker compose pull <service>`.
4. **recreating** — `docker compose up -d --no-deps <service>` — recreates **only** that one service, leaving the rest of the stack untouched.
5. **done**.

If anything fails mid-apply, the page rolls back: it restores the `.env` backup and re-creates the service on the old pin.

## Major-version bumps need an acknowledgement

A within-major upgrade (postgres `16-alpine` → a newer `16-x`) applies after the normal confirm. A **major** bump (postgres `16` → `18`, where the on-disk data format may not be forward-compatible) requires you to **tick an acknowledgement checkbox** in the modal before the Update button activates. Read the upstream release notes before doing a major database bump — AgentHub doesn't run data migrations for you.

## One update at a time

A shared update lock interlocks the Updates page with the AgentHub binary update (`POST /api/admin/update`, the Settings → Version "Update now" button). If one is running and you start the other, the second returns **HTTP 409 — another update is in progress**. Wait for the first to finish.

## Updates vs Packages vs `agenthub update`

| | Updates (this page) | [Packages](/docs/web-ui/packages/) | [`agenthub update`](/docs/operators/updates/) |
|---|---|---|---|
| What it upgrades | Bundled stack images (Traefik, Postgres, Redis, Infisical) | Coding-agent CLIs in your workspace | The AgentHub app + its `:local` images |
| Who | Admin only | Any user | Admin (web button) or host shell |
| Where it runs | Recreates one stack container | Inside your workspace container | Spawns the updater container |
| Scope | One service per apply | One CLI per install | Whole AgentHub stack |

## If something breaks

The apply rolls back the `.env` pin on failure, so the running container should land back where it was. If a recreate leaves a service unhealthy, `agenthub logs <service>` on the host is the next step — see [Troubleshooting](/docs/operators/troubleshooting/). The `.env` backup is kept (the last three are retained) so you can hand-restore a pin if you need to.
