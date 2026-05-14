---
title: Install Backup
---


Operator-scoped backup and restore of the three state components that make up an AgentHub install:

- `compose/.env` — domain, TLS mode, Infisical credentials, provisioner config
- `/data/agenthub.db` — SQLite: users, sessions, infrastructure configs, backup run history
- Infisical Postgres dump — all provider secrets (Cloudflare tokens, B2 keys, DO tokens, etc.)

**Workspace files are not included.** Per-user workspace content is backed up separately via the
workspace backup feature (Settings → Backups). This backup covers the install state only.

---

## Overview

Backups are bundled as a single `install-<domain>-<timestamp>.tar.gz` file. Each bundle contains
a `manifest.json` (source domain, git SHA, timestamp, trigger) plus the three state components
above. Bundles can be stored locally at `/data/install-backups/` and/or pushed to Backblaze B2.

The B2 destination is independent of the per-user B2 backup config — it uses a separate key/bucket
configured in Settings → Admin → Install Backup.

---

## Setup

### Configure backup storage (optional but recommended)

Default backend is **Backblaze B2** (native API). Any **S3-compatible** backend
also works — Cloudflare R2, MinIO, Wasabi, Storj, AWS S3 itself. Pick one:

#### Backblaze B2 (native)

1. In your B2 account, create a bucket (e.g. `mycompany-agenthub-installs`).
2. Create an application key with **Read and Write** access to that bucket.
3. AgentHub: Settings → Admin → Install Backup → B2 Configuration.
4. Fill in Key ID, Application Key, bucket name, and path prefix (default: `installs/`).
5. Click **Test connection**.

#### S3-compatible (R2, MinIO, Wasabi, Storj, AWS)

The PUT endpoint (`PUT /api/admin/install-backup`) accepts a `backend: "s3"`
field plus `endpoint` (URL) and `region` (defaults to `auto`). Web UI form
support is on the roadmap; until then, set via API:

```bash
# Cloudflare R2 example:
curl -X POST 'http://<your-host>/api/admin/install-backup' \
  -H "Cookie: $COOKIE" -H "Content-Type: application/json" -H "Origin: http://<your-host>" \
  -d '{
    "backend": "s3",
    "b2KeyId": "<your-r2-access-key-id>",
    "b2AppKey": "<your-r2-secret-access-key>",
    "b2Bucket": "<bucket>",
    "endpoint": "https://<account-id>.r2.cloudflarestorage.com",
    "region": "auto"
  }'
```

Field naming is `b2KeyId`/`b2AppKey` for back-compat — they're just access
credentials, applied generically by rclone. Confirm with the test endpoint.

If no backend is configured, backups run locally-only. Local bundles are
retained at `/data/install-backups/` and downloadable from the History table.

### Retention

Default: keep the 10 most recent bundles. Older bundles are pruned from both local storage and B2
after each successful run. Change the retention count in the B2 Configuration form.

Set retention to 0 to disable automatic pruning.

---

## Manual backup

### Web UI

Settings → Admin → Install Backup → **Run backup now**.

The button opens a log pane streaming progress via SSE. When the run completes you will see:

```
[backup] bundle written: /data/install-backups/install-example.com-2026-05-13T14-30-00Z.tar.gz (1234567 bytes)
[backup] uploaded to B2
[backup] pruned 1 old B2 bundle(s)
```

The run is recorded in the History table with status, size, destinations (local / B2), trigger, and
optional note.

### CLI

```bash
agenthub backup-install
```

Flags:

| flag | effect |
|------|--------|
| `--no-b2` | local copy only, skip B2 upload |
| `--note "text"` | attach a note to the run record |

Example — backup before a risky config change:

```bash
agenthub backup-install --note "before migrating to dns-01 TLS"
```

Output is streamed to stdout. Exit 0 on success, non-zero on failure.

---

## Auto-backup on update

`agenthub update` automatically runs a local-only backup immediately after `git pull` succeeds
and before the rebuild begins. The note is set to `auto-backup before update to <sha>`.

The backup is **best-effort**: if it fails (e.g. insufficient disk space), the update continues
with a warning. The previous backup, if any, is preserved.

To skip the auto-backup on a specific update run, there is no flag — cancel and use
`agenthub backup-install --no-b2` manually first if you need explicit control.

---

## Restore on a fresh VM

Use this path when the original host is gone and you need to recover onto a new Debian 12 VM.

### Prerequisites

Docker installed on the new host. The agenthub server image available locally or pullable. A
bundle file on disk or B2 credentials to pull it.

### Steps

1. Run the installer to get a minimal working stack:

   ```bash
   curl -fsSL https://your-domain/install.sh | bash
   ```

   Stop at the point where the installer has the server container running but before you configure
   anything in the UI. The next step overwrites the fresh database.

2. Copy the bundle to the new host (or use `--snapshot latest` to pull from B2):

   ```bash
   scp install-example.com-2026-05-13T14-30-00Z.tar.gz root@new-host:/data/install-backups/
   ```

3. Run the restore:

   ```bash
   agenthub restore-install --from /data/install-backups/install-example.com-2026-05-13T14-30-00Z.tar.gz
   ```

   Or pull from B2:

   ```bash
   agenthub restore-install --snapshot latest
   ```

   Add `--dry-run` to validate and show conflicts without applying.

4. The restore container will:
   - Extract and validate the bundle manifest.
   - Check for conflicts (active sessions, existing users, encryption key mismatch).
   - Stop the running AgentHub stack.
   - Replace `compose/.env`, `/data/agenthub.db`, and Infisical Postgres.
   - Bring the stack back up.

5. Verify recovery:

   ```bash
   agenthub status
   curl -s https://your-domain/api/health | jq .
   ```

The restore runs in a temporary container that mounts `/data`, `/repo`, and `docker.sock` — it
does not require the live server to be healthy.

---

## Restore from the web UI

Settings → Admin → Install Backup → Restore section.

Choose source (history or B2 timestamp), click **Dry-run validate** to see the manifest and any
conflicts, type the source domain to confirm, then click **Restore**. Progress streams in the log
pane. The UI sends the required `Confirm-Restore: yes-i-know-what-this-does` header after domain
confirmation.

---

## Threat model

The bundle is **not encrypted**. Anyone with access to the tar.gz can read:

- All environment variables from `compose/.env`, including `INFISICAL_ENCRYPTION_KEY`,
  `INFISICAL_AUTH_SECRET`, and `AGENTHUB_ADMIN_PASSWORD`.
- The SQLite database (users, session metadata, infrastructure config metadata).
- The Infisical Postgres dump (all provider secrets in Infisical's internal format, encrypted with
  `INFISICAL_ENCRYPTION_KEY`).

This is an **explicit design choice** — encryption would require managing a separate key, which
is a harder problem than the backup itself. If you lose the encryption key, the bundle is useless.

Protections in place:

- **B2 bucket ACLs** — use a private bucket; never expose bundles via public URLs.
- **Filesystem permissions** — `/data/install-backups/` is inside the server container; access
  requires Docker daemon access on the host.
- **B2 application key scope** — create the key scoped to a single bucket, not account-wide.

If a host is compromised, rotate all secrets in `compose/.env` (Infisical credentials, Cloudflare
tokens, B2 keys, admin password) and the B2 application key used for backups.

Encryption at rest for bundles is on the roadmap as an opt-in future feature.

---

## Retention

The `retentionKeepLast` setting (default 10) controls how many bundles are kept after each
successful run. Pruning applies to both local storage and B2 independently. Bundles are sorted
lexicographically by the embedded ISO timestamp in their filename — the oldest are deleted first.

Set to 0 to disable pruning entirely. There is no maximum enforced — large installations with
frequent auto-backups should increase retention and monitor `/data` disk usage.

Local bundles are downloadable from the History table. B2 bundles are not browsable from the UI;
use the Backblaze console or `rclone ls b2:<bucket>/installs/` to list them.

---

## Troubleshooting

### "B2 not configured" on run

The run endpoint returns 400 if B2 is not configured and `noB2` was not passed. Either configure
B2 in Settings → Admin → Install Backup, or use `--no-b2` for a local-only backup.

### rclone auth failure

```
[rclone] NOTICE: 2026/05/13 14:30:00 Failed to authenticate with B2
```

The application key is wrong or has been revoked. Re-enter it in the B2 Configuration form.
Check that the bucket name and key are for the same Backblaze account.

### Restore conflict: users-exist

```
{"kind":"users-exist","detail":"3 user(s) already exist"}
```

The target install is not fresh. Without `force=true`, restore is blocked to prevent silently
overwriting a live install. Confirm you are on the correct host. Use the web UI's dry-run
validate to inspect before proceeding.

### Restore conflict: encryption-key-mismatch

```
{"kind":"encryption-key-mismatch","detail":"current INFISICAL_ENCRYPTION_KEY differs from bundle"}
```

The Infisical Postgres dump was encrypted with a different key than the one in the target
install's `.env`. This means the restored Infisical data will be undecryptable. You must either
use the bundle's `.env` (which `applyRestore` replaces atomically) or accept data loss.
The restore will still apply `compose/.env` from the bundle, which carries the correct key.

### Bundle file missing after reboot

`/data/install-backups/` is a directory on the host volume mounted at `/data`. If the volume is
ephemeral (e.g. Dokploy with no persistent volume), bundles are lost on container restart. Mount a
persistent volume at `/data` — the installer does this automatically for the `docker` provisioner
mode.

### "pg_restore failed" during restore

Check Infisical Postgres is healthy first:

```bash
docker compose -f compose/docker-compose.yml exec infisical-postgres pg_isready -U infisical
```

The restore container must be on the compose network (`--network agenthub_default`) to reach
Infisical Postgres. The `agenthub restore-install` verb passes this flag automatically.
