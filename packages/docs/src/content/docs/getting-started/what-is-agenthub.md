---
title: What is AgentHub?
description: A one-page orientation for a user who just landed on AgentHub after install.
---

AgentHub is a self-hosted platform that lets you drive a coding agent from your browser. Log in, click **+ New session**, and a fresh Linux container boots with Claude Code (and friends) pre-installed. You type into a real terminal in the browser; the agent has a persistent home directory, network access, and a dedicated API endpoint for deploying its own apps.

## What's running on your host

After install you have one Docker Compose stack:

- **Traefik** on ports 80 / 443 / 8443 — reverse proxy + TLS
- **agenthub-server** — the React web UI and the Hono API backing it
- **infisical** + its Postgres and Redis — the bundled secret store
- One **workspace container per active session** — spun up on demand, torn down when you click *End session*

All of that runs on the one box you installed on. There's no control plane, no external registry, no phoning home.

## What a session is

A session is a long-running Linux container (Debian 12 slim) dedicated to one user. Inside:

- **Your home directory** is a Docker volume (`agenthub-home-{userId}`). It persists across `End session` → `+ New session`. Files you create survive container restarts, image upgrades, and host reboots.
- **Claude Code, OpenCode, MiniMax** are on `$PATH` — you can `claude`, `opencode`, `mmx`, or `claude-minimax` immediately.
- **A browser terminal** (xterm.js in the tab, ttyd + dtach in the container) attaches to a persistent shell. Close the tab, open it again, your shell is still there.
- **The `agentdeploy` MCP** is registered so your agent can deploy apps to Docker hosts, DigitalOcean droplets, or Dokploy via its own tool calls.
- **Pre-installed extras:** `rclone` (for backups), `gh` (GitHub CLI), `preview` (for sharing local ports), `tmux`, `dtach`, `ripgrep`, `fzf`.

## How data is partitioned

| Kind of data | Where it lives | Survives what |
|---|---|---|
| User accounts, session metadata | SQLite at `/data/agenthub.db` inside the server container | image upgrades |
| Provider tokens (Cloudflare, DigitalOcean, Backblaze, Dokploy) | Infisical at `/users/{userId}/...` | secret rotations, backups |
| Per-session home directory | Docker volume `agenthub-home-{userId}` | session end, image upgrades |
| TLS certificates | Docker volume `traefik-letsencrypt` | restarts |
| Infisical's own data | Docker volumes `infisical-pg-data` + `infisical-redis-data` | restarts |

No user-authored data is stored on the container filesystem layer, so rebuilding a workspace image never touches your files.

## Single-tenant by design

AgentHub assumes one operator running it for themselves or a small trusted team. Admin users can create other users and have a **Users** page; there's no tenant isolation, no billing surface, no SSO. If you need a multi-tenant SaaS you're in the wrong repo.

## Next step

Read [Your first session](/docs/getting-started/first-session/) to get into a working shell.
