---
title: Data & volumes
description: What lives where — every piece of state AgentHub manages, and how to back it up.
---

Every bit of persistent state AgentHub manages lives in one of a small number of Docker volumes (plus a git checkout on the host). This page is the inventory.

## The volumes

| Volume name | What's in it | Size at rest | Covered by |
|---|---|---|---|
| `agenthub-data` | SQLite database (`/data/agenthub.db`) with users, sessions, deployments, infra configs, backup runs. Also `/data/install-backups/` and `/data/workspace-backups/` directories. | ~1–10 MB (+ backup bundle sizes) | `agenthub backup-install` |
| `agenthub-home-{userId}` | One per user. The user's `/home/coder` — code, credentials, configs, installed packages. | Grows with user data; typically 100 MB – 10 GB | `agenthub backup-workspace --user <name>` |
| `infisical-pg-data` | Infisical's Postgres — all provider secrets, audit log, org/project/identity config. | ~100 MB | `agenthub backup-install` (dumped into the bundle) |
| `infisical-redis-data` | Infisical's Redis cache. | ~5 MB | Rebuilds from Postgres — no backup needed. |
| `traefik-letsencrypt` | Let's Encrypt certificate storage (public access mode only). | ~100 KB | Regenerates from ACME on first request — no backup needed. |

Volumes are namespaced under the compose project `agenthub`, so actual Docker volume names are `agenthub_agenthub-data`, `agenthub_infisical-pg-data`, etc. Run `docker volume ls | grep agenthub` to see them.

## Backing up AgentHub

Two CLI verbs cover everything that matters:

```bash
# Install state — compose/.env + SQLite + Infisical Postgres dump,
# bundled together. Auto-runs before every `agenthub update`.
sudo agenthub backup-install

# Per-user workspace — one user's /home/coder volume as tar.zst.
sudo agenthub backup-workspace --user alice
# Or all users in one go:
sudo agenthub backup-workspace --all
```

Both write to `/data/install-backups/` and `/data/workspace-backups/` locally, and push to Backblaze B2 (or any S3-compatible backend) if you've configured one. See [Install Backup](/docs/operators/install-backup/) for B2/S3 setup + retention.

For a true cross-VM migration (dead host → fresh box), run both and follow the [Disaster Recovery](/docs/operators/disaster-recovery/) walkthrough.

### Raw access (if you need it)

The CLI verbs are the right path for almost everyone. If you have a non-standard need (snapshot to an unusual backend the rclone-driven CLI doesn't support, or just want a one-off file copy), reach into the volumes directly:

```bash
# SQLite (platform state)
docker run --rm -v agenthub_agenthub-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/agenthub-data-$(date +%F).tgz -C /data .

# Infisical (secrets)
docker run --rm -v agenthub_infisical-pg-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/infisical-pg-data-$(date +%F).tgz -C /data .
```

Restore by reversing the tar into a **fresh** volume of the same name, with the containers stopped.

### Important: Infisical encryption key

Infisical encrypts secret values using the `INFISICAL_ENCRYPTION_KEY` from `compose/.env`. If you restore `infisical-pg-data` to a new host without also restoring that key, every secret becomes unrecoverable gibberish. `agenthub backup-install` includes `compose/.env` in the bundle so this is handled automatically — only the raw-access recipe above needs you to back up `.env` separately.

## What's on the host filesystem

Outside of Docker volumes, AgentHub writes to:

| Path | Purpose |
|---|---|
| `<install-dir>` | The git checkout. The server has it mounted rw at `/repo` so it can run git commands for the Version panel and spawn the updater. |
| `<install-dir>/compose/.env` | Secrets for compose. Mode 0600. Included in `agenthub backup-install` bundles. |
| `/usr/local/bin/agenthub` | The operator CLI. Auto-installed by `agenthub update`. |
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

With 5 active sessions you're looking at ~3–5 GB total. Plan host sizing accordingly — the README's recommended `8 GB RAM` accommodates 5–7 simultaneous sessions comfortably.
