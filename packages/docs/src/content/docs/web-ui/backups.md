---
title: Backups
description: Snapshot /home/coder to Backblaze B2 and restore on demand.
---

**Backups** is a simple page for shipping `/home/coder` from your active session to a Backblaze B2 bucket and pulling it back on demand. It's operations-only: you set up the B2 credentials once on the [Integrations page](/docs/web-ui/integrations/), and this page is the button to run the backup.

## Prerequisites

Before the Save and Restore buttons do anything useful:

1. A **Backblaze B2 bucket** exists (create one in your B2 console).
2. An **application key** exists with read+write access to that bucket.
3. The key + bucket are saved as a Backblaze B2 integration on the [Integrations page](/docs/web-ui/integrations/).
4. You have an **active session** (backups run inside the workspace container, not on the host).

Miss any of those and the page tells you what's missing.

## Save — ship `/home/coder` to B2

Click **Save**. The server:

1. Fetches your B2 credentials from Infisical (`/users/{userId}/b2`).
2. Sends a `{type: "backup", op: "save", ...}` WebSocket message to the agent daemon in your active session.
3. The agent daemon writes a temp `rclone.conf` (0600), runs `rclone sync /home/coder b2:{bucket}/{subdir}`, and reports the byte count + file count back.
4. A row is written to the `backup_runs` SQLite table with timestamp, duration, size.

You see a row appear in the run history with a `running` → `complete` or `failed` state. Failures include the stderr tail from rclone for diagnosis.

## Restore — pull from B2 into the session

Click **Restore**. Same message flow, reversed: the agent runs `rclone sync b2:{bucket}/{subdir} /home/coder`. **This overwrites** your current `/home/coder` with the remote copy. There is no confirmation dialog beyond the click — you're expected to know what you're doing.

If you want to restore a **point-in-time snapshot** instead of the latest, B2's versioning does this: open the restore dialog, pick a timestamp, and the agent adds `--b2-versions` to the rclone call. (Requires the bucket to have versioning enabled on the B2 side.)

## Run history

The run-history table shows the last N backups with:

- Timestamp (when it started)
- Operation (save or restore)
- Duration
- Bytes transferred
- File count
- Status (complete / failed)
- Error (if failed)

There's no "delete this backup" button — that's a B2 operation. Log into the B2 console to expire old versions, or set up a lifecycle rule there.

## Why it runs inside the session

The alternative would be the server SSHing into the workspace or mounting its volume. Both create awkward coupling. Running inside the session:

- Keeps the server's footprint small (no rclone on the server).
- Uses the per-session agent daemon's existing WebSocket.
- Means backup behavior is visible in the session's own `~/.rclone.log` if you want to debug.

The cost is the "requires an active session" constraint. If that bites you, start a session before backing up — the container boot is 5–15 seconds.

## What about AgentHub's own data?

This page backs up user home directories, not the platform itself. To back up AgentHub's SQLite database, Infisical's Postgres, or the Traefik cert store, use standard Docker volume tooling. See [Data & volumes](/docs/operators/data/).
