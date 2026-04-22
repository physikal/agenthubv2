---
title: Sessions
description: The My Sessions page — creating workspaces, the browser terminal, and what persists.
---

**My Sessions** is the default page when you log in. It lists every workspace container you own and gives you a browser terminal into whichever one you click.

## Creating a session

Click **+ New session**. The form:

| Field | Required? | What it does |
|---|---|---|
| Name | yes | Display label in the sidebar. |
| Repo URL | no | If set, the workspace clones this git URL to `~/repo` on first boot. |
| Starting prompt | no | Written to `~/.prompt` for you to pipe into whichever agent you launch. |

Click **Create**. The session row cycles through states:

1. `creating` — server is writing the DB row (instant).
2. `starting` — the provisioner (Docker / Dokploy) is bringing up the container.
3. `active` — container is running **and** its agent daemon has connected back over WebSocket. This is the "ready to use" state.

Typical time to `active` on local Docker mode: **5–15 seconds**. First-time workspace image pulls from a registry can take longer.

If the row goes to `failed`, check [Troubleshooting — session stuck](/docs/operators/troubleshooting/#session-stuck-in-connecting-to-agent-forever).

## The terminal

Click an active session row. The right pane opens an xterm.js terminal wired to a persistent shell inside the container. You're the `coder` user (uid 1000) with passwordless sudo.

- **Closing the tab** does not kill the shell. The agent daemon keeps the shell attached to a `dtach` socket; reopening the session re-attaches to the same session. Scrollback is preserved.
- **Resizing the browser** resends a resize event through ttyd so the `$COLUMNS/$LINES` stay correct.
- **Copy/paste** works with the usual host shortcuts (Cmd+C / Ctrl+C, etc.). Ctrl+C sends SIGINT to the foreground process as you'd expect.

The terminal is ttyd speaking WebSocket to the server, which proxies to ttyd inside the container. Protocol details are in [`docs/architecture.md`](https://github.com/physikal/agenthubv2/blob/main/docs/architecture.md#terminal-protocol) — you don't need them unless you're debugging the pipeline.

## Session states

| State | Meaning |
|---|---|
| `creating` | Server is writing the DB row. Transient. |
| `starting` | Container is being provisioned. |
| `active` | Container up **and** agent daemon WS connected. Use it. |
| `idle` | Agent daemon WS disconnected, but container still running. Usually transient — server auto-reconnects. |
| `completed` | You ended the session. Home volume is preserved. |
| `failed` | Provisioner error. See logs. |

## Ending a session

Click the session and hit **End session**. This:

- Gracefully stops the agent daemon
- Destroys the workspace container
- **Keeps the `agenthub-home-{userId}` volume** — your files stay

Starting a new session mounts the same volume, so anything in `/home/coder` comes back exactly as you left it.

## Persistence rules

| What | Persists across session end? | Persists across image upgrade? | Persists across user delete? |
|---|---|---|---|
| `/home/coder` (everything you wrote) | yes | yes | **no** |
| Running processes | no (container is destroyed) | no | no |
| Environment variables set in shell | no (container is destroyed) | no | no |
| Env vars set via `~/.bashrc` | yes | yes | no |
| Credentials (`~/.claude`, `~/.config/gh`, etc.) | yes | yes | no |

The one thing that purges `/home/coder` is deleting the user. That's intentional — it's how operators clean up after someone who's no longer on the team.

## Limitations

- **One active session per user at a time** is recommended but not enforced. You *can* spin up multiple; they all share the same `agenthub-home-{userId}` volume, which causes write conflicts. Stick to one.
- **Host memory** is your limit. Each workspace is a full Debian container — budget 300–800 MB per idle session, more under active agent load.
- **Backups require an active session** because the rclone call runs inside the workspace. See [Backups](/docs/web-ui/backups/).
