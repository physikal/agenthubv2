# AgentHub v2 — Development Guide

## What is this?
Self-hostable web platform for running coding-agent sessions in containers. Successor to AgentHub v1 (`github.com/physikal/agenthub`). v1 required Proxmox + k3s; v2 runs on plain Docker or Dokploy.

Monorepo packages:
- `packages/web` — React 19 + Vite frontend (unchanged from v1)
- `packages/server` — Hono backend (provisioner layer rewritten)
- `packages/agent` — daemon inside workspace container
- `packages/installer` — Ink TUI, `npx agenthub-install`

## Quick reference
- **Database**: SQLite at `/data/agenthub.db` (Drizzle ORM)
- **Secrets**: Infisical (bundled service; SDK = `@infisical/sdk`)
- **Provisioner modes**: `docker` | `dokploy-local` | `dokploy-remote` (env var `PROVISIONER_MODE`)
- **Agent image**: built from `docker/Dockerfile.agent-workspace` (replaces v1's `infra/lxc-template.sh`)

## Development
```bash
pnpm install
pnpm dev          # all packages in parallel
pnpm typecheck    # must pass before commit
pnpm build        # production build
```

## Architecture decisions
- **Provisioner driver abstraction** (`packages/server/src/services/provisioner/`) — swappable at install time. Adding a new driver means implementing one interface.
- **Rootless Docker posture** — AgentHub must NOT bind-mount `/var/run/docker.sock`. Docker driver uses `DOCKER_HOST=tcp://...` against a rootless daemon. Server refuses to start if it detects a host socket mount.
- **Infisical for all provider secrets** — Cloudflare tokens, B2 keys, DO tokens live in Infisical paths (`/users/{userId}/...`), not SQLite JSON. SQLite stores only references.
- **Cookie auth** (not JWT) — carries WebSocket upgrade automatically.
- **ttyd + dtach** for terminal persistence (see `packages/server/src/ws/terminal-proxy.ts` for ASCII type-byte framing).
- **No warm pool** — v1's `ContainerPool` was compensating for slow Proxmox clone. Docker cold-start is ~2-3s; pool dropped for simplicity.
- **Single Docker image for workspaces** — agent daemon baked in at build time, not deployed at provision time (simpler than v1).

## Common gotchas
- ttyd requires `{"AuthToken":""}` after WS connect — blank terminal without it.
- ttyd type bytes are ASCII (`'0'` = 0x30), not binary (0x00) — input silently ignored if wrong.
- Infisical needs Postgres migration on first boot — installer waits for `healthy` before provisioning machine identity.
- Dokploy is dual-licensed; we integrate via API (fine) and document the install one-liner rather than bundling the installer (safer).
- SQLite `sessions` table renamed v1→v2: `lxcVmid`/`lxcNode`/`lxcIp` → `workspaceId`/`workspaceHost`/`workspaceIp`. Provider-generic.
