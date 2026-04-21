# AgentHub v2

Self-hostable web platform for running coding-agent sessions in isolated containers. Log in through the browser, spin up a workspace with Claude Code / OpenCode / MiniMax pre-installed, and let the agent deploy its own workloads through the bundled `agentdeploy` MCP.

**v2 vs v1.** v1 (`github.com/physikal/agenthub`) required a Proxmox cluster + k3s + NFS and was effectively un-self-hostable for anyone outside the author's homelab. v2 swaps the infrastructure layer to **Docker or Dokploy** — one host, one command, you're running.

## Install (TL;DR)

```bash
npx agenthub-install
```

Prereqs: Docker 24+ and 2 GB of free RAM. That's it. The installer walks you through provisioner choice (Docker / bundled Dokploy / remote Dokploy), domain, Cloudflare DNS, and Backblaze backups, then brings up the stack.

Agent-friendly headless install:

```bash
AGENTHUB_MODE=docker \
AGENTHUB_DOMAIN=localhost \
AGENTHUB_ADMIN_PASSWORD=change-me \
npx agenthub-install --non-interactive
```

Full docs: [docs/install/humans.md](docs/install/humans.md) · [docs/install/agents.md](docs/install/agents.md)

## Architecture

```
Browser (React + xterm.js)
  │  WebSocket + REST (cookie-auth)
  ▼
AgentHub Server (Hono)
  ├── SQLite              (users, sessions, infra records)
  ├── Infisical           (all provider secrets)
  ├── ProvisionerDriver
  │     ├── DockerDriver         (rootless Docker, local)
  │     └── DokployDriver        (local bundle OR remote URL)
  │           │
  │           ▼
  │   Agent workspace container
  │     (ttyd + dtach + Claude Code + agentdeploy MCP)
  │
  └── Agent WS ─▶ agent daemon inside workspace
```

Inside each workspace the `agentdeploy` MCP gives the agent tools to deploy *its own* apps to:

- Docker host over SSH
- DigitalOcean (droplet provisioning + Docker + Traefik)
- Dokploy (API, no SSH)

All paired with Cloudflare DNS and optional Backblaze B2 backups (both ported unchanged from v1).

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | React 19, Vite, xterm.js 5, Tailwind CSS 4, Zustand |
| Backend | Hono, better-sqlite3, Drizzle, ws, bcryptjs, dockerode |
| Agent runtime | ttyd + dtach, Claude Code, OpenCode, MiniMax |
| Secrets | Infisical (bundled) |
| Orchestration | Docker Compose; optional Dokploy |
| Installer | Ink (React for terminals) |

## Development

```bash
pnpm install
pnpm dev        # web + server + agent in dev mode
pnpm typecheck  # must pass before commit
pnpm build      # production
```

See [docs/architecture.md](docs/architecture.md) for the driver contract and how to add a new provisioner.
