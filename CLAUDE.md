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
pnpm test         # vitest unit suite (installer + server + agent)
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

### TLS strategy surface (PRs #62 + #65-#69, 2026-05-06)

**Four modes** drive Traefik's cert resolver, picked at install or via `agenthub reconfigure-tls`:
- `auto` (default) — `localhost` → no resolver (default cert); else `dns-01` if `AGENTHUB_TLS_DNS_PROVIDER` set, else `public-alpn`
- `public-alpn` — Let's Encrypt via TLS-ALPN-01 (today's behavior; needs port 443 reachable from public internet)
- `dns-01` — Let's Encrypt via DNS-01 (works for internal-only hosts; Cloudflare in TUI, lego env vars for ~80 other providers)
- `self-ca` — private CA generated on-host with openssl, leaf SAN covers domain + wildcard + LAN IP, daily auto-renew sidecar, CA distributed via `http://<domain>/install/ca`

**Compose layout:** the base `compose/docker-compose.yml` carries Traefik's core CLI flags (entrypoints, providers.docker, http→https redirect). TLS-mode-specific config goes into `compose/traefik.override.yml` as **`environment:` (TRAEFIK_*-prefixed env vars)**, NOT a `command:` array. **This is load-bearing**: docker-compose merges `command:` lists by REPLACING — putting TLS flags in `command:` clobbers the base Traefik config and breaks every label-based router. PR #69 fixed exactly that bug; the unit tests now assert `traefik.command === undefined` for every override mode as a regression guard. `.env` carries `COMPOSE_FILE=docker-compose.yml:traefik.override.yml` for non-localhost installs (auto-set by installer + `agenthub reconfigure-tls`).

**TLS probe parsing:** `openssl s_client -showcerts` does NOT emit `notBefore=…`/`notAfter=…` lines (it emits `NotBefore: …; NotAfter: …` on a single line). Both `packages/installer/src/lib/tls/probe-cert.ts` and `packages/server/src/services/tls/health.ts` PIPE s_client output through `openssl x509 -noout -subject -issuer -dates` to get the canonical key=value form their regex parsers expect. Don't shortcut to a single openssl call — PR #69 fixed exactly that.

**Loud-failure gate** (`packages/installer/src/headless.ts` `probeFrontDoor`): after install, the cert is read via the piped openssl probe above and the install fails (exit 3) if Traefik is serving its built-in `CN=TRAEFIK DEFAULT CERT`. **Never** silently fall back — if you're touching the install flow, preserve this gate.

**Reconfigure semantics:** `agenthub reconfigure-tls` snapshots `traefik.override.yml.prev` before writing the new override; restores on probe failure unless `--no-rollback`. `--regen-cert` (self-CA only) re-runs `traefik-self-ca-init` with `REGEN=1`. Web UI hits the same code path via `POST /api/admin/tls/reconfigure` (SSE-streamed).

**TLS health surface** is read-once-cache-60s via `openssl s_client` from inside the agenthub-server container. Surfaces:
- `GET /api/health` adds a `tls: { ok, resolver, issuer, daysToExpiry, warnings }` field
- Settings → TLS card (`packages/web/src/components/tls/TlsCard.tsx`)
- Top-of-app `MigrationBanner` when `resolver === 'default-fallback'`
- `agenthub status` adds a TLS line

**Where the code lives:**
- `packages/installer/src/lib/tls/` — render-override, resolve-mode, probe-cert, lego-providers, lan-ip, preflight, migrate
- `packages/installer/src/{reconfigure,reconfigure-cli,reconfigure-app}.{ts,tsx}` — reconfigure flow
- `packages/server/src/services/tls/{health,reconfigure}.ts` — health probe + reconfigure-via-updater-container
- `packages/web/src/components/tls/{TlsCard,MigrationBanner,ReconfigureTlsModal}.tsx` — UI
- `scripts/self-ca-{init,renew}.sh` — alpine-container scripts
- `compose/static/install-ca/` — platform-aware trust-instructions page

**Authoritative reference:** `docs/superpowers/specs/2026-05-05-flexible-tls-install-design.md` and the five plans at `docs/superpowers/plans/2026-05-05-tls-plan-{1..5}-*.md`. User-facing: `docs/install/tls-modes.md`.

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
- **TLS override flags are env vars, not a `command:` array.** docker-compose's `command:` merge REPLACES the base list — putting `--certificatesresolvers.*` flags there strips Traefik's `--providers.docker=true` + entrypoints from the running container (PR #69). All TLS config goes in `services.traefik.environment:` as `TRAEFIK_*`-prefixed vars; the override file is generated; don't hand-edit it either — use `agenthub reconfigure-tls`.
- **TLS-mode-aware `probeFrontDoor` exits 3 on default cert** — if you write a new install path, route through `probeFrontDoor(domain, resolvedMode)` from `headless.ts` so the loud-failure gate fires.
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

Full E2E (requires a fresh Debian 12 Docker host): use `scripts/e2e-full.js` — covers health, auth, Infisical round-trip (Cloudflare + B2), session creation, workspace agent, and backup plumbing. Self-cleaning: unwinds every fixture it creates before exit. Invocation:
```bash
docker cp scripts/e2e-full.js agenthub-agenthub-server-1:/tmp/e2e.js
docker exec -e ADMIN_PASSWORD=<pw> agenthub-agenthub-server-1 node /tmp/e2e.js
```

## Release flow

1. Commit on `main`
2. CI (`docs/ci/deploy.yml.pending` — currently parked, needs `gh auth refresh -s workflow` to activate) builds + pushes both images to GHCR on merge
3. Users pull with `docker compose pull` and restart their stack
