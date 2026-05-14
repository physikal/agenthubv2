---
title: The agenthub CLI
description: The /usr/local/bin/agenthub tool — update, status, backup, restore, logs, restart, reconfigure-access.
---

The installer drops an `agenthub` binary into `/usr/local/bin/` on your host. It's the canonical way to operate the install from the shell. The web UI buttons (Update / Backup) call the same code paths.

## Subcommands

```bash
agenthub update                # pull + rebuild + recreate + health probe (auto-backs-up first)
agenthub update --check        # dry-run: show pending commits, don't apply
agenthub status                # current SHA + running compose services + access mode
agenthub logs [service]        # tail logs for one or all services
agenthub restart               # docker compose restart — useful after .env edits
agenthub version               # just print the version info

agenthub backup-install        # tar.gz of compose/.env + SQLite + Infisical Postgres
agenthub restore-install       # restore an install bundle (runs in a temp container)
agenthub backup-workspace      # tar.zst snapshot of a user's /home/coder volume
agenthub restore-workspace     # extract a workspace bundle back into a user's volume

agenthub reconfigure-access    # switch between lan and public access modes post-install
```

No config file, no flags beyond what's listed below.

## `update`

This is the one you'll use most. Under the hood:

1. **Auto-backup (best-effort)** — runs `agenthub backup-install` before any destructive step so you can roll back. Non-blocking: a failed backup prints a warning but doesn't abort the update.
2. **`git fetch && git rev-list --count HEAD..origin/main`** — is there anything to pull?
3. **`git pull`** — fetch the latest code.
4. **`docker compose up -d`** — land any compose config drift without recreating containers.
5. **`docker build`** — rebuild any images whose source changed (`docker/Dockerfile.server`, `docker/Dockerfile.agent-workspace`, `docker/Dockerfile.updater`).
6. **`docker compose up -d --force-recreate agenthub-server`** — restart the server with the new image.
7. **DB migrations** — the server runs pending migrations on boot. If they fail, the server refuses to start and `agenthub` prints the failure.
8. **Front-door probe** — fetch `/api/health` (HTTP on `lan` mode, HTTPS on `public`) and confirm the new SHA is being served. Advisory only — a probe failure prints a warning but doesn't roll back; the verify-server-image check above is the authoritative recreate gate.
9. **Install new CLI** — if `scripts/agenthub` changed, copy the new version to `/usr/local/bin/agenthub`. Next invocation picks it up.

Every step is idempotent. Run `agenthub update` twice in a row and the second call does almost nothing.

```bash
# Dry-run: see what would be pulled without applying
agenthub update --check
```

This prints the list of pending commits + affected files. Useful for sanity-checking before a production-critical upgrade.

## `status`

```bash
$ agenthub status
Git
  installed: 877d67f
  origin   : 877d67f
  up to date

Compose services
SERVICE              STATE     STATUS
agenthub-server      running   Up 12 minutes (healthy)
infisical            running   Up 2 days
infisical-postgres   running   Up 2 days (healthy)
infisical-redis      running   Up 2 days (healthy)
traefik              running   Up 12 minutes

TLS
  ok    Access: LAN (http://agenthub.example.com)
```

Equivalent to `git log -1` + `docker compose ps` + a quick TLS health probe, packaged together.

## `logs`

```bash
agenthub logs                    # interleaved, all services, last 100 lines
agenthub logs agenthub-server    # one service, last 100 lines, follow mode
```

Equivalent to `docker compose -f compose/docker-compose.yml logs`. Mostly a typing shortcut.

## `restart`

```bash
agenthub restart                 # restart everything
agenthub restart agenthub-server # one service
```

Runs `docker compose restart`. Useful after editing `compose/.env` — containers need a restart to see the new env vars.

## `version`

```bash
$ agenthub version
AgentHub at /home/owen/agenthubv2
  commit : 877d67f
  date   : 2026-05-14T22:55:34Z
```

## `backup-install` / `restore-install`

Snapshot `compose/.env` + `/data/agenthub.db` + an Infisical Postgres dump as a single `tar.gz` bundle. Optionally pushed to Backblaze B2 (or any S3-compatible backend — see [Install Backup](/docs/operators/install-backup/)).

```bash
# Local-only bundle:
sudo agenthub backup-install --local-only --note "before risky change"

# Restore the latest bundle from B2:
sudo agenthub restore-install --snapshot latest

# Or restore from a local file copied off another host:
sudo agenthub restore-install --from /tmp/install-mycompany-2026-05-14.tar.gz
```

`restore-install` runs in a one-shot temp container so it can replace `.env`, SQLite, and Infisical Postgres while the live stack restarts cleanly. See the [Install Backup](/docs/operators/install-backup/) doc for B2 setup + retention.

## `backup-workspace` / `restore-workspace`

Per-user `/home/coder` Docker volume snapshotted as a `tar.zst` bundle. Composes with `restore-install` to make a true cross-VM migration possible — install state + per-user files.

```bash
# Back up one user:
sudo agenthub backup-workspace --user alice

# Back up everyone (continues on per-user failures):
sudo agenthub backup-workspace --all

# Restore (refuses while user has active sessions — end them first):
sudo agenthub restore-workspace --user alice --snapshot latest
```

See [Workspace Backup](/docs/operators/workspace-backup/) for the safety semantics. The `--force` flag on restore does NOT bypass the active-sessions guard — `docker volume rm` on a live-mounted volume produces a phantom volume the running container keeps writing to.

## `reconfigure-access`

Switch between `lan` and `public` access modes after install. See [Access modes](/docs/operators/access-modes/).

```bash
# Interactive (walks through the same three-question flow as the installer TUI):
sudo agenthub reconfigure-access

# Headless:
AGENTHUB_ACCESS_MODE=public \
AGENTHUB_TLS_MODE=dns-01 \
AGENTHUB_TLS_EMAIL=ops@example.com \
AGENTHUB_TLS_DNS_PROVIDER=cloudflare \
AGENTHUB_CLOUDFLARE_API_TOKEN=<token> \
sudo agenthub reconfigure-access --non-interactive
```

The deprecated alias `agenthub reconfigure-tls` still works for one release.

## Relationship to the Web UI buttons

The web UI's **Update now**, **Run backup now**, and **Restore from backup** buttons all spawn the same code paths these CLI verbs run, via short-lived helper containers. There's no functional difference — use whichever surface is convenient.

## Relationship to `docker compose`

`agenthub` is a thin wrapper. If you know docker-compose, you can reach the same state with:

```bash
cd <install-dir>
git pull
docker build -f docker/Dockerfile.server -t agenthubv2-server:local .
docker compose -f compose/docker-compose.yml up -d --force-recreate agenthub-server
```

The CLI just gives you one verb for that whole thing, plus auto-backup, plus DB-migration awareness, plus the lan-aware front-door probe.

## Config file

Location: `/etc/agenthub/config`. Contains the install directory + owner:

```
AGENTHUB_DIR=/home/you/agenthubv2
AGENTHUB_OWNER=1000:1000
```

Written by the installer. You don't normally edit it. If the install directory moves, update this file.

## Uninstalling the CLI

```bash
sudo rm /usr/local/bin/agenthub
sudo rm -rf /etc/agenthub
```

Doesn't touch the compose stack. Run `docker compose down -v` separately to tear down AgentHub itself.
