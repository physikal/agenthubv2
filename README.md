# AgentHub v2

Self-hostable web platform for running coding-agent sessions in isolated containers. Log in through the browser, spin up a workspace with Claude Code / OpenCode / MiniMax pre-installed, and let the agent deploy its own workloads through the bundled `agentdeploy` MCP.

Runs on **one host with Docker**. One command, ~5 minutes, you're running.

## Install

**Requirements:** any supported Linux host with sudo access, internet, 4 GB RAM, 20 GB disk. The installer auto-provisions git, Docker, Docker Compose plugin, Node 22, and pnpm if they're missing. Supported distros: Debian/Ubuntu, Fedora/RHEL/Rocky/Alma, Arch, Alpine.

### One-liner

```bash
curl -fsSL https://raw.githubusercontent.com/physikal/agenthubv2/main/scripts/quick-install.sh | bash
```

Interactive: asks for your consent before installing any missing prereq, then launches the TUI. Re-running later is a safe self-updater.

Headless / agent-driven (no prompts for anything, including prereq installs):

```bash
curl -fsSL https://raw.githubusercontent.com/physikal/agenthubv2/main/scripts/quick-install.sh \
  | AGENTHUB_AUTO_INSTALL=true \
    AGENTHUB_MODE=docker \
    AGENTHUB_DOMAIN=localhost \
    AGENTHUB_ADMIN_PASSWORD=change-me-please \
    bash -s -- --non-interactive
```

### Manual (clone-first)

```bash
git clone https://github.com/physikal/agenthubv2.git
cd agenthubv2
./scripts/install.sh
```

When install finishes you'll see **two** admin credential sets — one for AgentHub, one for the bundled Infisical secret store. Both are also written to `compose/.env`. If you lose the Infisical password, log in to the AgentHub Secrets page and click "Reveal Infisical admin login" to recover it.

**Ports opened**: 80 (HTTP→HTTPS redirect), 443 (AgentHub), 8443 (Infisical console).

Full install docs: [docs/install/humans.md](docs/install/humans.md) · [docs/install/agents.md](docs/install/agents.md) · [docs/install/installer-flow.md](docs/install/installer-flow.md) · [docs/troubleshooting.md](docs/troubleshooting.md)

The complete **user manual** is also bundled with every install at `/docs` — browse to `https://<your-host>/docs/` after install, or click **Docs** in the sidebar.

## What's in the box

```
Browser (React + xterm.js)
  │  WebSocket + REST, cookie-auth
  ▼
┌───────────────────────── docker compose bundle ─────────────────────────┐
│  traefik (:80 → :443, :8443)                                            │
│    ├─▶ :443  agenthub-server (Hono + SPA)                               │
│    │          ├─ SQLite      (users, sessions, integrations)            │
│    │          ├─ Infisical   (Cloudflare tokens, B2 keys, DO tokens…)   │
│    │          └─ Docker / Dokploy driver                                │
│    │              └─▶ workspace container (per session)                 │
│    │                    agent daemon + ttyd + Claude Code + MCP         │
│    └─▶ :8443 infisical (raw admin console, self-signed TLS)             │
└─────────────────────────────────────────────────────────────────────────┘
```

**Web UI pages** (after login):
- **Sessions** — active workspace containers + terminal
- **Deployments** — apps the agent has deployed
- **Integrations** — Cloudflare DNS, DigitalOcean, Docker host, Dokploy, Backblaze B2 (one page, typed forms, secrets in Infisical)
- **Backups** — snapshot save/restore + history
- **Secrets** — link to the bundled Infisical admin console for folders/environments/audit log
- **Settings** — account, password, and (admin-only) **Version** panel with one-click update pulled from GitHub

**Operator CLI** (installed to `/usr/local/bin/agenthub`):
`agenthub update` · `agenthub status` · `agenthub logs` · `agenthub restart` · `agenthub version`. Same flow the web UI's Update button triggers — one code path.

Inside each workspace, `agentdeploy` MCP lets the agent deploy *its* apps to: Docker host over SSH · DigitalOcean (droplet + Docker + Traefik) · Dokploy (API, no SSH). Plus Cloudflare DNS automation and optional Backblaze B2 backups (per-user, run from inside the workspace via the agent daemon — backups require an active session so the agent can reach `/home/coder`).

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
