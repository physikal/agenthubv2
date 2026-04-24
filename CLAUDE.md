# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this?
Self-hostable web platform for running coding-agent sessions in containers. Runs on plain Docker or Dokploy.

Monorepo packages:
- `packages/web` — React 19 + Vite frontend. Pages: Sessions / Deployments / Integrations / Backups / Secrets / Settings (+ admin: Users)
- `packages/server` — Hono backend
- `packages/agent` — daemon inside workspace container (backup ops + terminal control)
- `packages/installer` — Ink TUI, `./scripts/install.sh`

## Quick reference
- **Database**: SQLite at `/data/agenthub.db` (Drizzle ORM)
- **Secrets**: Infisical (bundled service, bootstrapped by the installer; SDK = `@infisical/sdk`; console on :8443)
- **Provisioner modes**: `docker` | `dokploy-remote` (env var `PROVISIONER_MODE`)
- **Agent image**: `docker/Dockerfile.agent-workspace`
- **Server image**: `docker/Dockerfile.server` (includes `git` for the Version endpoint)
- **Updater image**: `docker/Dockerfile.updater` (alpine + git + docker-cli, used by web UI "Update now")
- **Compose bundle**: `compose/docker-compose.yml`
- **Operator CLI**: `/usr/local/bin/agenthub` (installed by `scripts/install.sh`, source at `scripts/agenthub`). Subcommands: `update` / `status` / `logs` / `restart` / `version`.
- **Repo mount**: the server container has the install's git checkout at `/repo` (rw) so `/api/admin/version` can shell to git and `/api/admin/update` can spawn the updater container.

## Development

Toolchain is pinned: Node ≥22, pnpm 10.12.1 (see `packageManager` in root `package.json`). Workspace is `packages/*`.

```bash
pnpm install
pnpm dev          # all packages in parallel (web + server + agent)
pnpm typecheck    # must pass before commit
pnpm lint         # per-package lint (runs where defined)
pnpm test         # vitest (19 unit tests, installer + server)
pnpm build        # production build
```

Run a single test file (must be scoped to the package that owns it):
```bash
pnpm --filter @agenthub/server exec vitest run path/to/file.test.ts
pnpm --filter @agenthub/server exec vitest run -t "test name substring"
```

## Architecture decisions

### Two independent provisioner layers (most load-bearing concept)
The codebase has **two** swappable driver abstractions that are easy to confuse:

1. **Outer — how AgentHub provisions a workspace container per session.** Lives in `packages/server/src/services/provisioner/*`. Picked at install time via `PROVISIONER_MODE` (`docker` | `dokploy-remote`). Interface: `ProvisionerDriver` (`create`/`start`/`stop`/`destroy`/`status`/`waitForIp`/`listAll`).
2. **Inner — how an agent inside a workspace deploys its own apps.** Lives in `packages/server/src/services/providers/*` + the `agentdeploy` MCP (`packages/agent/src/mcp-deploy.ts`). Picked per-user via `infrastructure_configs` rows. Interface: `HostingProvider` (`validate`/`verify`/`provision`/`destroy`).

Both layers support Docker and Dokploy, but they are **separate code paths with separate drivers**. One install can run outer=`docker` and inner=`digitalocean` simultaneously. When adding hosting support, figure out which layer you're in before touching either directory. Full walkthrough in `docs/architecture.md`.

### Other decisions
- **Provisioner driver abstraction** (`packages/server/src/services/provisioner/`) — swappable at install time. Adding a new driver means implementing one interface. See `docs/architecture.md`.
- **Docker driver mounts `/var/run/docker.sock`** — gated by `AGENTHUB_ALLOW_SOCKET_MOUNT=true`. The installer wires this automatically for `docker` mode. Users who need zero-socket-mount pick `dokploy-remote` where Dokploy owns the daemon.
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
INFISICAL_ADMIN_EMAIL, INFISICAL_ADMIN_PASSWORD
```

See `compose/.env.example` for the full list with comments.

## Common gotchas
- ttyd requires `{"AuthToken":""}` after WS connect — blank terminal without it.
- ttyd type bytes are ASCII (`'0'` = 0x30), not binary (0x00) — input silently ignored if wrong.
- Infisical needs Postgres migration on first boot — installer waits up to 180s for `/api/status` before running `infisical bootstrap`.
- Infisical admin credentials (email + password) are persisted in `compose/.env` and recoverable via the Secrets page "Reveal Infisical admin login" card (admin-only, gated by AgentHub password re-entry). Required because Infisical has self-registration disabled and no working SMTP reset; the password printed once during install could not be recovered otherwise.
- `docker compose up` re-probes the registry for locally-tagged images even after `pull --ignore-pull-failures` — that's why we pin `--pull never` on `up` (registry images are cached by the preceding pull step).
- pnpm's symlinked node_modules don't survive `docker COPY` — the workspace Dockerfile uses `npm install --omit=dev` for agent deps to get a real flat tree.
- Per-session `AGENT_TOKEN` env var injected by SessionManager — the agent reads it as `AGENT_TOKEN`.
- Session-creation → `active` requires about 5-15 seconds (container start + agent WS handshake). Tests should poll, not block-sleep.
- SQLite `sessions` table uses provider-generic columns: `workspaceId`/`workspaceHost`/`workspaceIp`.
- `infrastructure_configs` table holds all integrations — compute providers (`docker`/`digitalocean`/`dokploy`), DNS (`cloudflare`), and backups (`b2`). Routes: `/api/infra` for CRUD, `/api/user/backup` is a thin alias over the `provider='b2'` row for ops-page use.
- Updates: `agenthub update` is the canonical code path. The web UI `POST /api/admin/update` spawns an `agenthubv2-updater:local` container that runs the same CLI — so both paths share all the migration / rebuild / recreate logic. Compose config drift is handled by `compose up -d` before the `--force-recreate agenthub-server` step.
- The CLI self-updates from `scripts/agenthub` in the repo, then re-execs, with an `AGENTHUB_SELF_UPDATED=1` sentinel so the re-exec doesn't loop or short-circuit as "nothing to do".

## Testing

Unit tests (vitest): `pnpm test`. Only pure-function tests today; add more under `**/*.test.ts` in installer + server.

Full E2E (requires a fresh Debian 12 Docker host): use `scripts/e2e-full.js` — 21-check script covering health, auth, Infisical round-trip (Cloudflare + B2), session creation, workspace agent, and backup plumbing. Self-cleaning: unwinds every fixture it creates before exit. Invocation:
```bash
docker cp scripts/e2e-full.js agenthub-agenthub-server-1:/tmp/e2e.js
docker exec -e ADMIN_PASSWORD=<pw> agenthub-agenthub-server-1 node /tmp/e2e.js
```

## Release flow

1. Commit on `main`
2. CI (`docs/ci/deploy.yml.pending` — currently parked, needs `gh auth refresh -s workflow` to activate) builds + pushes both images to GHCR on merge
3. Users pull with `docker compose pull` and restart their stack
