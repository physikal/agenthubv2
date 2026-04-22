# AgentHub — Development Guide

## What is this?
Self-hostable web platform for running coding-agent sessions in containers. Runs on plain Docker or Dokploy.

Monorepo packages:
- `packages/web` — React 19 + Vite frontend
- `packages/server` — Hono backend
- `packages/agent` — daemon inside workspace container (backup ops + terminal control)
- `packages/installer` — Ink TUI, `./scripts/install.sh`

## Quick reference
- **Database**: SQLite at `/data/agenthub.db` (Drizzle ORM)
- **Secrets**: Infisical (bundled service, bootstrapped by the installer; SDK = `@infisical/sdk`)
- **Provisioner modes**: `docker` | `dokploy-local` | `dokploy-remote` (env var `PROVISIONER_MODE`)
- **Agent image**: `docker/Dockerfile.agent-workspace`
- **Server image**: `docker/Dockerfile.server`
- **Compose bundle**: `compose/docker-compose.yml` (+ `docker-compose.dokploy.yml` overlay)

## Development
```bash
pnpm install
pnpm dev          # all packages in parallel
pnpm typecheck    # must pass before commit
pnpm test         # vitest (19 unit tests, installer + server)
pnpm build        # production build
```

## Architecture decisions
- **Provisioner driver abstraction** (`packages/server/src/services/provisioner/`) — swappable at install time. Adding a new driver means implementing one interface. See `docs/architecture.md`.
- **Docker driver mounts `/var/run/docker.sock`** — gated by `AGENTHUB_ALLOW_SOCKET_MOUNT=true`. The installer wires this automatically for `docker` mode. Users who need zero-socket-mount pick a `dokploy-*` mode where Dokploy owns the daemon.
- **Infisical for all provider secrets** — Cloudflare tokens, B2 keys, DO tokens live in Infisical at `/users/{userId}/...` paths, not SQLite JSON. SQLite stores only metadata/references. Bootstrap is automated via `npx @infisical/cli bootstrap` (see `packages/installer/src/lib/infisical-bootstrap.ts`).
- **Cookie auth** (not JWT) — carries WebSocket upgrade automatically.
- **ttyd + dtach** for terminal persistence (`packages/server/src/ws/terminal-proxy.ts` has the ASCII type-byte framing).
- **No warm pool** — Docker cold-start is ~2-3s, so sessions are provisioned on demand.
- **Single Docker image for workspaces** — agent daemon baked in at build time, not deployed at provision time.
- **Backup runs inside the workspace** — the agent daemon receives a `{type: "backup", op, requestId, params}` WS message from the server and runs rclone locally against `/home/coder`. Requires an active session.

## Key runtime env vars (in compose/.env)
```
DOMAIN, TLS_EMAIL, AGENTHUB_ADMIN_PASSWORD
PROVISIONER_MODE, DOCKER_HOST (optional)
DOKPLOY_URL, DOKPLOY_API_TOKEN, DOKPLOY_PROJECT_ID, DOKPLOY_ENVIRONMENT_ID
AGENTHUB_SERVER_IMAGE, WORKSPACE_IMAGE
INFISICAL_URL, INFISICAL_PROJECT_ID, INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET
INFISICAL_ENCRYPTION_KEY, INFISICAL_AUTH_SECRET, INFISICAL_DB_PASSWORD, INFISICAL_REDIS_PASSWORD
```

See `compose/.env.example` for the full list with comments.

## Common gotchas
- ttyd requires `{"AuthToken":""}` after WS connect — blank terminal without it.
- ttyd type bytes are ASCII (`'0'` = 0x30), not binary (0x00) — input silently ignored if wrong.
- Infisical needs Postgres migration on first boot — installer waits up to 180s for `/api/status` before running `infisical bootstrap`.
- `docker compose up` re-probes the registry for locally-tagged images even after `pull --ignore-pull-failures` — that's why we pin `--pull never` on `up` (registry images are cached by the preceding pull step).
- pnpm's symlinked node_modules don't survive `docker COPY` — the workspace Dockerfile uses `npm install --omit=dev` for agent deps to get a real flat tree.
- Per-session `AGENT_TOKEN` env var injected by SessionManager — the agent reads it as `AGENT_TOKEN`.
- Session-creation → `active` requires about 5-15 seconds (container start + agent WS handshake). Tests should poll, not block-sleep.
- SQLite `sessions` table uses provider-generic columns: `workspaceId`/`workspaceHost`/`workspaceIp`.

## Testing

Unit tests (vitest): `pnpm test`. Only pure-function tests today; add more under `**/*.test.ts` in installer + server.

Full E2E (requires a fresh Debian 12 Docker host): use `/tmp/agenthub-e2e-full.js` — 21-check script covering health, auth, Infisical round-trip (Cloudflare + B2), session creation, workspace agent, and backup plumbing. Intended to be run via `docker exec agenthub-agenthub-server-1 node /tmp/e2e.js` after an install.

## Release flow

1. Commit on `main`
2. CI (`docs/ci/deploy.yml.pending` — currently parked, needs `gh auth refresh -s workflow` to activate) builds + pushes both images to GHCR on merge
3. Users pull with `docker compose pull` and restart their stack
