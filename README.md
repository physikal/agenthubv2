# AgentHub v2

Self-hostable web platform for running coding-agent sessions in isolated containers. Log in through the browser, spin up a workspace with Claude Code / OpenCode / MiniMax pre-installed, and let the agent deploy its own workloads through the bundled `agentdeploy` MCP.

**v2 vs v1.** v1 (`github.com/physikal/agenthub`) required a Proxmox cluster + k3s + NFS. v2 runs on **one host with Docker**. One command, ~5 minutes, you're running.

## Install

Prerequisites: **Docker 24+** and Docker Compose plugin, on one Linux host, ports 80 and 443 free, 4 GB RAM, 20 GB disk.

```bash
# 1. Clone
git clone https://github.com/physikal/agenthubv2.git
cd agenthubv2

# 2. Build dependencies (installer + images)
./scripts/install.sh
```

Prefer env-driven / non-interactive? (Ideal for Claude Code, OpenClaw, Hermes, etc.)

```bash
AGENTHUB_MODE=docker \
AGENTHUB_DOMAIN=localhost \
AGENTHUB_ADMIN_PASSWORD=change-me-please \
./scripts/install.sh --non-interactive
```

When install finishes you'll see **two** admin credential sets — one for AgentHub, one for the bundled Infisical secret store. Both are also written to `compose/.env`.

Full install docs: [docs/install/humans.md](docs/install/humans.md) · [docs/install/agents.md](docs/install/agents.md) · [docs/troubleshooting.md](docs/troubleshooting.md)

## What's in the box

```
Browser (React + xterm.js)
  │  WebSocket + REST, cookie-auth
  ▼
┌───────────────────────── docker compose bundle ─────────────────────────┐
│  traefik (:80/:443, Let's Encrypt)                                      │
│    └─▶ agenthub-server (Hono)                                           │
│          ├─ SQLite        (users, sessions, infra records)              │
│          ├─ Infisical     (Cloudflare tokens, B2 keys, DO tokens…)      │
│          └─ Docker / Dokploy driver                                     │
│              └─▶ workspace container (per session)                      │
│                    agent daemon + ttyd + Claude Code + agentdeploy MCP  │
└─────────────────────────────────────────────────────────────────────────┘
```

Inside each workspace, `agentdeploy` MCP lets the agent deploy *its* apps to:
- Docker host over SSH
- DigitalOcean (droplet + Docker + Traefik)
- Dokploy (API, no SSH)

Plus Cloudflare DNS automation and optional Backblaze B2 backups (per-user, run from inside the workspace via the agent daemon — backups require an active session so the agent can reach `/home/coder`).

## Install modes

| Mode | What it is | When to pick |
|---|---|---|
| `docker` | AgentHub runs workspace containers on the local Docker daemon. Default. | You're self-hosting on one box and just want it to work. |
| `dokploy-local` | Bundles Dokploy alongside AgentHub. | You want Dokploy's UI to manage workspace apps. |
| `dokploy-remote` | Points at a pre-existing Dokploy instance. | You already run Dokploy. |

`docker` mode mounts `/var/run/docker.sock` into the server container (gated by `AGENTHUB_ALLOW_SOCKET_MOUNT=true` — set automatically by the installer). If you need zero-socket-mount security, use a `dokploy-*` mode where Dokploy owns the daemon access.

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | React 19, Vite, xterm.js 5, Tailwind CSS 4, Zustand |
| Backend | Hono, better-sqlite3, Drizzle, ws, bcryptjs, dockerode |
| Agent runtime | ttyd + dtach, Claude Code, OpenCode, MiniMax |
| Secrets | Infisical (bundled, bootstrapped automatically) |
| Orchestration | Docker Compose; optional Dokploy |
| Installer | Ink (React for terminals) |

## Development

```bash
pnpm install
pnpm dev        # web + server + agent in dev mode
pnpm typecheck  # must pass before commit
pnpm test       # vitest unit suite (19 tests)
pnpm build      # production dist
```

Adding a new provisioner or hosting provider: see [docs/architecture.md](docs/architecture.md).

## License + acknowledgements

The AgentHub codebase in this repo is open for self-hosting. Bundled services retain their own licenses — notably **Dokploy** ships with a dual license (AGPL + proprietary); we integrate via API, which is fine, but redistributing their image in a commercial product deserves a license read.
