---
title: Supporting tools
description: The non-agent CLIs baked into every workspace — rclone, gh, preview, tmux, ripgrep, fzf.
---

Every workspace image ships with a small set of supporting CLIs that agents (and humans) reach for constantly. None of them need configuring — they're just on `$PATH`.

## `preview` — share a local port from the session

The `preview` command prints a URL your laptop browser can open to reach a port inside the workspace, routed through the AgentHub server.

```bash
# you're running a dev server on :3000 inside the workspace
$ preview :3000
https://your-host.example.com/api/sessions/a1b2c3/preview/port/3000/
```

Open that in your browser. AgentHub proxies the HTTP(S)+WebSocket traffic back to your session container. Auth is cookie-based — only *you* (or another logged-in user with access to the session) can hit the URL.

`preview` also works for files:

```bash
$ preview ./build/report.html
https://your-host.example.com/api/sessions/a1b2c3/preview/file/home/coder/build/report.html
```

Under the hood it uses the `AGENTHUB_SESSION_ID` and `AGENTHUB_URL` env vars that the server injects at container create time. If `preview` says *"not in an AgentHub session"*, one of those is missing.

## `rclone` — cloud storage

Used internally by AgentHub's backup feature (see [Backups](/docs/web-ui/backups/)), but also available for ad-hoc use. A few examples:

```bash
rclone config                                           # interactive remote setup
rclone copy ~/some-output/ b2:your-bucket/some-output   # push to Backblaze B2
rclone lsf s3:your-bucket/                              # list an S3 remote
```

rclone is global — configure it once in your session and remotes persist in `~/.config/rclone/` on the workspace volume.

## `gh` — GitHub CLI

[GitHub's official CLI](https://cli.github.com), pre-authenticated to nothing. On first use:

```bash
gh auth login
```

Follow the OAuth flow. After that, `gh pr create`, `gh issue list`, etc. all work against your repos. The token lives in `~/.config/gh/`.

## `tmux` + `dtach`

Two terminal multiplexers. `dtach` is the simpler one — AgentHub uses it internally to make your ttyd shell survive browser tab closes. You rarely use it directly.

`tmux` is the full multiplexer. Use it for splitting the session shell into multiple panes, or for running long background processes that shouldn't die when you disconnect.

## `ripgrep` (as `rg`)

Fast regex search. Drop-in replacement for `grep -r`. Used by essentially every agent CLI for codebase search, but also a useful tool for humans:

```bash
rg 'TODO' packages/server/src
rg --files-with-matches 'Drizzle' .
```

## `fzf` — fuzzy finder

```bash
cat ~/.bash_history | fzf                      # pick from shell history
rg --files | fzf                               # pick a file to edit
```

Combined with `rg --vimgrep | fzf`, you have a decent keyboard-only code search UI.

## Other system utilities

Pre-installed apt packages include the usual suspects: `curl`, `wget`, `git`, `openssh-client`, `build-essential`, `unzip`, `sudo`, `ca-certificates`. Run `apt list --installed 2>/dev/null | head -50` inside a session to see the full set.

Installing more with `sudo apt install <pkg>` works but **does not persist** — anything in `/usr/` is wiped when the container is destroyed. If you need a persistent tool, install it to `/home/coder/.local/bin`, or ask us to add it to the workspace image.
