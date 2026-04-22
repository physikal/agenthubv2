---
title: The agenthub CLI
description: The /usr/local/bin/agenthub tool — update, status, logs, restart, version.
---

The installer drops an `agenthub` binary into `/usr/local/bin/` on your host. It's the canonical way to operate the install from the shell. The web UI's Update button calls the same code path.

## Subcommands

```bash
agenthub update           # pull + rebuild + recreate + health probe
agenthub update --check   # dry-run: show pending commits, don't apply
agenthub status           # current SHA + running compose services
agenthub logs [service]   # tail logs for one or all services
agenthub restart          # docker compose restart — useful after .env edits
agenthub version          # just print the version info
```

That's the complete surface. No config file, no flags beyond the obvious.

## `update`

This is the one you'll use most. Under the hood:

1. **`git fetch && git rev-list --count HEAD..origin/main`** — is there anything to pull?
2. **`git pull`** — fetch the latest code.
3. **Self-update step** — if `scripts/agenthub` changed, install the new version to `/usr/local/bin/agenthub` and `exec` the new binary. A sentinel env var prevents a loop.
4. **`docker compose up -d`** — land any compose config drift without recreating containers.
5. **`docker build`** — rebuild any images whose source changed (`docker/Dockerfile.server`, `docker/Dockerfile.agent-workspace`, `docker/Dockerfile.updater`).
6. **`docker compose up -d --force-recreate agenthub-server`** — restart the server with the new image.
7. **DB migrations** — the server runs pending migrations on boot. If they fail, the server refuses to start and `agenthub` prints the failure.
8. **Health probe** — wait up to 60s for `/api/health` to return `{"status":"ok"}`.

Every step is idempotent. Run `agenthub update` twice in a row and the second call does almost nothing.

```bash
# Dry-run: see what would be pulled without applying
agenthub update --check
```

This prints the list of pending commits + affected files. Useful for sanity-checking before a production-critical upgrade.

## `status`

```bash
$ agenthub status
version: v2.3.1 (759e96d on main, clean)
services:
  traefik            running  v3.6
  infisical          running  latest-postgres
  infisical-postgres running  16-alpine
  infisical-redis    running  7-alpine
  agenthub-server    running  agenthubv2-server:local (built 2m ago)
```

Equivalent to `git log -1` + `docker compose ps`, just packaged.

## `logs`

```bash
agenthub logs                    # interleaved, all services, last 100 lines
agenthub logs agenthub-server    # one service, last 100 lines
agenthub logs -f                 # follow mode
```

Equivalent to `docker compose -f compose/docker-compose.yml logs`. Mostly a typing shortcut so you don't have to remember the compose path.

## `restart`

```bash
agenthub restart
```

Runs `docker compose restart`. Useful after editing `compose/.env` — containers need a restart to see the new env vars.

## `version`

```bash
$ agenthub version
AgentHub v2.3.1
  Commit:   759e96d
  Branch:   main
  Date:     2026-04-18 09:12:44 -0500
  Image:    agenthubv2-server:local
```

Just the version info, without talking to Docker or the remote.

## Relationship to the Web UI's Update button

Both paths run **the same underlying code**. The web UI's "Update now" button POSTs to `/api/admin/update`, which spawns a one-shot `agenthubv2-updater:local` container. That container runs `agenthub update`, streams progress back to the UI, and exits. The same migrations, rebuilds, and recreates — just triggered via docker instead of direct shell.

So: use the web UI when you're not at a terminal, use `agenthub update` when you are. There's no functional difference.

## Relationship to `docker compose`

`agenthub` is a thin wrapper. If you know docker-compose, you can reach the same state with:

```bash
cd <install-dir>
git pull
docker build -f docker/Dockerfile.server -t agenthubv2-server:local .
docker compose -f compose/docker-compose.yml up -d --force-recreate agenthub-server
```

The CLI just gives you one verb for that whole thing.

## Config file

Location: `/etc/agenthub/config`. Contains the install directory:

```
AGENTHUB_DIR=/home/you/agenthubv2
```

Written by the installer. You don't normally edit it. If the install directory moves, update this file.

## Uninstalling the CLI

```bash
sudo rm /usr/local/bin/agenthub
sudo rm -rf /etc/agenthub
```

Doesn't touch the compose stack. Run `docker compose down -v` separately to tear down AgentHub itself.
