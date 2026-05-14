# AgentHub

> **Status: beta.** Active development; the `agenthub update` command handles migrations between releases automatically. Breaking changes between releases are still possible — pin a tag in production.

Self-hostable web platform for running coding-agent sessions in isolated containers. Log in through the browser, spin up a workspace with Claude Code / OpenCode / MiniMax pre-installed, and let the agent deploy its own workloads through the bundled `agentdeploy` MCP.

Runs on **one host with Docker**. One command, ~5 minutes, you're running.

## Install

**Minimum hardware**: 4 GB RAM, 2 vCPU, 20 GB disk.
**Recommended**: 8 GB RAM, 2-4 vCPU, 40 GB disk for comfortable single-user use; 16 GB for small teams. Each active session container adds ~600 MB.

**Supported hosts**: Debian / Ubuntu (tested), Fedora / RHEL / Rocky / Alma (best-effort), Arch (best-effort), Alpine (best-effort). The installer auto-detects the distro family and provisions git, Docker, Docker Compose plugin, Node 22, and pnpm if missing. **macOS / Windows / WSL2 are not currently supported** — install Docker + Node 22 + pnpm manually and run `./scripts/install.sh` only if you know what you're doing.

**Firewall**: open `tcp/80` always; `tcp/443` if you opt into public access mode; `tcp/8443` for the Infisical admin console.

```bash
# UFW (Debian/Ubuntu)
sudo ufw allow 80/tcp && sudo ufw allow 8443/tcp
# firewalld (Fedora/RHEL)
sudo firewall-cmd --add-port=80/tcp --add-port=8443/tcp --permanent && sudo firewall-cmd --reload
```

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

**Ports opened**: 80 (AgentHub — plain HTTP in the default lan access mode), 443 (only opened when you opt into public access mode for Let's Encrypt), 8443 (Infisical console). See [docs/install/access-modes.md](docs/install/access-modes.md) for the lan-vs-public choice.

Full install docs: [docs/install/humans.md](docs/install/humans.md) · [docs/install/agents.md](docs/install/agents.md) · [docs/install/installer-flow.md](docs/install/installer-flow.md) · [docs/troubleshooting.md](docs/troubleshooting.md) · [docs/operations/disaster-recovery.md](docs/operations/disaster-recovery.md)

The complete **user manual** is also bundled with every install at `/docs` — browse to `http://<your-host>/docs/` after install (HTTPS if you picked public access mode), or click **Docs** in the sidebar.

## What's in the box

```
Browser (React + xterm.js)
  │  WebSocket + REST, cookie-auth
  ▼
┌───────────────────────── docker compose bundle ─────────────────────────┐
│  traefik (:80 always; :443 only in public access mode; :8443)           │
│    ├─▶ :80   agenthub-server (Hono + SPA)  ← default in lan mode        │
│    │   or :443 in public mode (LE cert via public-alpn or dns-01)       │
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
- **Integrations** — Cloudflare DNS, DigitalOcean, Docker host, Dokploy, Backblaze B2, AI provider keys (one page, typed forms, secrets in Infisical, **click Verify to live-probe**)
- **Backups** — snapshot save/restore + history
- **Secrets** — link to the bundled Infisical admin console for folders/environments/audit log
- **Settings** — account, password, and (admin-only) **Version** panel with one-click update pulled from GitHub

**Operator CLI** (installed to `/usr/local/bin/agenthub`):
`agenthub update` · `agenthub status` · `agenthub logs` · `agenthub restart` · `agenthub version` · `agenthub backup-install` / `agenthub restore-install` · `agenthub backup-workspace` / `agenthub restore-workspace`. Same flow the web UI buttons trigger — one code path.

Inside each workspace, `agentdeploy` MCP lets the agent deploy *its* apps to: Docker host over SSH · DigitalOcean (droplet + Docker + Traefik) · Dokploy (API, no SSH). Plus Cloudflare DNS automation and Backblaze B2 backups.

## Install modes

| Mode | What it is | When to pick |
|---|---|---|
| `docker` | AgentHub runs workspace containers on the local Docker daemon. Default. | You're self-hosting on one box and just want it to work. |
| `dokploy-remote` | Points at a pre-existing Dokploy instance. | You already run Dokploy. |

`docker` mode mounts `/var/run/docker.sock` into the server container (gated by `AGENTHUB_ALLOW_SOCKET_MOUNT=true` — set automatically by the installer). If you need zero-socket-mount security, use `dokploy-remote` so Dokploy owns the daemon access and AgentHub talks to it over HTTP.

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
pnpm test       # vitest unit suite
pnpm build      # production dist
```

Adding a new provisioner or hosting provider: see [docs/architecture.md](docs/architecture.md).

## License + acknowledgements

The AgentHub codebase in this repo is open for self-hosting. Bundled services retain their own licenses — notably **Dokploy** ships with a dual license (AGPL + proprietary); we integrate via API, which is fine, but redistributing their image in a commercial product deserves a license read.
