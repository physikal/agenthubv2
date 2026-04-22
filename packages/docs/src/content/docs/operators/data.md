---
title: Data & volumes
description: What lives where — every piece of state AgentHub manages, and how to back it up.
---

Every bit of persistent state AgentHub manages lives in one of a small number of Docker volumes (plus a git checkout on the host). This page is the inventory.

## The volumes

| Volume name | What's in it | Size at rest | When you'd back it up |
|---|---|---|---|
| `agenthub-data` | SQLite database (`/data/agenthub.db`) with users, sessions, deployments, infra configs, backup runs. | ~1–10 MB | Always. This is the platform's state. |
| `agenthub-home-{userId}` | One per user. The user's `/home/coder` — code, credentials, configs, installed packages. | Grows with user data; typically 100 MB – 10 GB | Per-user, via the [Backups page](/docs/web-ui/backups/) — that's what it's for. |
| `infisical-pg-data` | Infisical's Postgres — all secrets, audit log, org/project/identity config. | ~100 MB | Always. Losing this loses every provider credential. |
| `infisical-redis-data` | Infisical's Redis cache. | ~5 MB | Optional — rebuilds from Postgres. |
| `traefik-letsencrypt` | Let's Encrypt certificate storage. | ~100 KB | Optional — regenerates if you have TLS email + DNS. |

Volumes are namespaced under the compose project `agenthub`, so actual Docker volume names are `agenthub_agenthub-data`, `agenthub_infisical-pg-data`, etc. Run `docker volume ls | grep agenthub` to see them.

## Backing up AgentHub's own data

The user-facing Backups feature handles **user home directories** (`agenthub-home-*`). For everything else — SQLite, Infisical's Postgres, Let's Encrypt — back up Docker volumes directly:

```bash
# SQLite (platform state)
docker run --rm -v agenthub_agenthub-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/agenthub-data-$(date +%F).tgz -C /data .

# Infisical (secrets)
docker run --rm -v agenthub_infisical-pg-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/infisical-pg-data-$(date +%F).tgz -C /data .
```

Store these offsite (S3, B2, whatever). Restore by reversing the tar into a **fresh** volume of the same name, with the containers stopped.

### Important: Infisical encryption key

Infisical encrypts secret values using the `INFISICAL_ENCRYPTION_KEY` from `compose/.env`. If you restore `infisical-pg-data` to a new host without also restoring that key, every secret becomes unrecoverable gibberish. **Back up `compose/.env` alongside the volumes.** Treat it with the same care as the encryption key itself — it contains every random secret the installer generated.

## What's on the host filesystem

Outside of Docker volumes, AgentHub writes to:

| Path | Purpose |
|---|---|
| `<install-dir>` | The git checkout. The server has it mounted rw at `/repo` so it can run git commands for the Version panel and spawn the updater. |
| `<install-dir>/compose/.env` | Secrets for compose. Mode 0600. Back this up. |
| `/usr/local/bin/agenthub` | The operator CLI. Regenerable — reinstalls on `./scripts/install.sh`. |
| `/etc/agenthub/config` | Points the CLI at the install dir. Regenerable. |

If `<install-dir>` has uncommitted changes, `git pull` during an update will conflict. Either commit them, stash them, or hard-reset — the install dir is treated as code, not data.

## What happens on container destroy

| Action | Effect on volumes |
|---|---|
| End one session | `agenthub-home-{yourId}` survives. Everything else untouched. |
| `docker compose down` | All containers destroyed. All volumes **kept**. |
| `docker compose down -v` | All containers destroyed **and** compose-managed volumes deleted. `agenthub-home-*` volumes survive because they're created lazily per-session. |
| Delete a user (admin Users page) | `agenthub-home-{userId}` is deleted. |
| `docker volume rm agenthub-home-<userId>` | Irreversibly deletes that user's home dir. The user record in SQLite is not affected. |

The most destructive one-liner — the "I want a totally clean state" command — is in [Troubleshooting](/docs/operators/troubleshooting/#how-do-i-wipe-everything-and-start-over).

## Where memory goes

Not data, exactly, but relevant to capacity planning:

- **agenthub-server** — ~150 MB idle, grows with number of active sessions (each holds one agent WebSocket + a little metadata).
- **infisical** — ~150 MB idle.
- **infisical-postgres** — ~80 MB idle.
- **infisical-redis** — ~5 MB idle.
- **traefik** — ~40 MB idle.
- **Per workspace container** — 300–800 MB idle. Under active agent load (big prompts, long outputs), peaks at 1–2 GB.

With 5 active sessions you're looking at ~3–5 GB total. Plan host sizing accordingly.
