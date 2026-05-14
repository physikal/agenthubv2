# Workspace volume backup + restore

Operator-driven backup of per-user `/home/coder` volumes — the second half
of the backup story alongside [install-state backup](install-backup.md).
One configured B2 destination holds both — no extra credentials needed if
`agenthub backup-install` already works.

## When to use this

- Before an `agenthub update` that touches the workspace image (the
  install-state backup hook fires automatically, but `/home/coder` is
  not in the install bundle — back it up here too if the user has
  uncommitted work that matters).
- Cross-VM migration: rsync the install bundle + every user's workspace
  bundle, then `restore-install --from ...` on the new VM, then
  `restore-workspace --user <id> --snapshot latest` for each user.
- Pre-debug: snapshot before letting an agent loose in a session.

`--user` accepts a username or user UUID.

## CLI

```bash
# Back up one user's workspace
sudo agenthub backup-workspace --user alice

# Back up everyone (best-effort — per-user failures don't abort the run)
sudo agenthub backup-workspace --all

# Local-only (skip B2 push) for a one-off
sudo agenthub backup-workspace --user alice --local-only --note "pre-refactor"

# Restore latest snapshot from B2
sudo agenthub restore-workspace --user alice --snapshot latest

# Restore a specific snapshot (filename as seen in B2 listing)
sudo agenthub restore-workspace --user alice --snapshot workspace-<id>-2026-05-14T17-31-37-123Z.tar.zst

# Restore from a local file (e.g. one scp'd from another host)
sudo agenthub restore-workspace --user alice --from /tmp/workspace-alice.tar.zst

# Overwrite a non-empty workspace volume (operator must end live sessions first)
sudo agenthub restore-workspace --user alice --snapshot latest --force
```

`--user` accepts a username or a user UUID — whichever you know.

## What's in the bundle

- The full contents of the `agenthub-home-{userId}` Docker volume —
  whatever the user has at `/home/coder` inside their sessions.
  **Including** `node_modules`, `.git`, `.cache` — this is a true
  volume snapshot, not a curated copy.
- A `agenthub-workspace-manifest.json` header entry recording the
  creation timestamp, user id/name, and the workspace image SHA in
  use at the time. Restore extracts the volume contents and skips the
  manifest entry.

Format: `tar -c | zstd -19` (high-ratio compression, single-pass
streaming). The server image bakes in `zstd` — no extra dependency on
the host.

## Path layout

- **Host:** `/data/workspace-backups/{userId}/workspace-{userId}-{ts}.tar.zst`
- **B2:** `b2://{bucket}/{install-prefix}/workspaces/{userId}/workspace-{userId}-{ts}.tar.zst`
  - Where `{install-prefix}` is whatever the existing install-backup
    config stores (`installs/` by default). Workspaces tree nests
    under the same prefix so one configured B2 destination holds
    everything; `b2List` views show them side by side.

## Safety rails

- **Restore refuses on active sessions.** The runner queries the
  `sessions` table for `userId` and rejects restore if any session is
  in `creating | starting | waiting_login | active | waiting_input |
  idle`. The `--force` flag intentionally does NOT bypass this check —
  removing a live-mounted Docker volume produces a phantom volume the
  running container keeps writing to, and the restored data silently
  diverges on the new volume. End sessions explicitly first.
- **Restore is destructive.** With `--force` on a non-empty volume,
  the volume is `docker volume rm`'d and recreated before extraction.
  No merge.
- **Backup is fuzzy.** The volume is bind-mounted read-only into the
  bundler sidecar, but the user's own session can still write through
  its own rw mount during the snapshot. tar's
  `--warning=no-file-changed` lets the bundler accept those races —
  same semantics as the install-state backup.

## Bundles are UNENCRYPTED

Like install-state bundles, workspace bundles are written + uploaded
in cleartext. Security relies on B2 bucket ACLs + filesystem perms on
`/data/workspace-backups/`. If a host or B2 key is compromised, treat
every user's `/home/coder` as exfiltrated. Opt-in encryption is on the
roadmap.

## Composition with restore-install

`restore-install` does NOT auto-restore workspaces today. Run the
two verbs in sequence on a fresh VM:

```bash
# On the new VM, after curl|bash install completes:
sudo agenthub restore-install --snapshot latest    # users + secrets back
# Then for each user that should pick up old work:
sudo agenthub restore-workspace --user alice --snapshot latest
sudo agenthub restore-workspace --user bob   --snapshot latest
```

The two-step is deliberate — install-state restore takes seconds,
workspace restore can take minutes per user (large `/home/coder`),
and not every recovery wants both halves.
