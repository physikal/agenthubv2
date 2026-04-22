# AgentHub v2 — Architecture

## One diagram

```
┌────────────────────────────────── AgentHub bundle (docker compose) ────────────────────────────────┐
│                                                                                                    │
│                            Traefik (:80 / :443, Let's Encrypt)                                     │
│                              │                                                                     │
│                              ├─▶ agenthub-server (:3000)                                           │
│                              │     │                                                               │
│                              │     ├── SQLite: users, sessions, deployments, infra records        │
│                              │     ├── Infisical SDK ─▶ infisical (:8080) ─▶ postgres + redis     │
│                              │     └── ProvisionerDriver (one of: docker | dokploy-local | -remote)│
│                              │            │                                                        │
│                              │            ▼                                                        │
│                              │   one workspace container per active session                        │
│                              │     ┌─────────────────────────────────┐                             │
│                              │     │ agent daemon (:9876)  [root]    │  ← ws back to server        │
│                              │     │ ttyd (:7681)          [coder]   │  ← browser terminal        │
│                              │     │ Claude Code / OpenCode / MMX    │                             │
│                              │     │ agentdeploy MCP (stdio)         │                             │
│                              │     │ rclone (for backups)            │                             │
│                              │     └─────────────────────────────────┘                             │
│                              │     volume: agenthub-home-{userId}:/home/coder (persistent)         │
│                              │                                                                     │
│                              └─▶ infisical (:8080, at secrets.{DOMAIN} + 127.0.0.1:8080 local)     │
│                                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
                      ▲                                                          ▼
                      │ user browser                                   agent-driven deploys via MCP
                      │                                                  (docker / digitalocean / dokploy)
```

## Two independent provisioner layers

The most important distinction to understand about v2:

1. **Outer:** how AgentHub spins up a workspace container FOR each session. Implemented by `services/provisioner/*`. Config: `PROVISIONER_MODE` env var.
2. **Inner:** how an agent deploys ITS apps from inside a workspace. Implemented by `services/providers/*` + the `agentdeploy` MCP. Config: user-created `infra` records.

Both layers support Docker and Dokploy, but they're separate code paths with separate drivers. A user can run AgentHub with `PROVISIONER_MODE=docker` (outer = local Docker) and deploy their agent's apps to a DigitalOcean droplet (inner = DigitalOcean) in the same install.

## Outer provisioner driver contract

```ts
// packages/server/src/services/provisioner/types.ts
interface ProvisionerDriver {
  readonly mode: "docker" | "dokploy-local" | "dokploy-remote";

  create(req: WorkspaceCreateRequest): Promise<WorkspaceRef>;
  start(ref: WorkspaceRef): Promise<void>;
  stop(ref: WorkspaceRef): Promise<void>;
  destroy(ref: WorkspaceRef, opts?: { keepVolume?: boolean }): Promise<void>;
  status(ref: WorkspaceRef): Promise<WorkspaceStatus>;
  waitForIp(ref: WorkspaceRef, timeoutMs?: number): Promise<string>;
  listAll(): Promise<WorkspaceRef[]>;
}
```

### Adding a new outer provisioner driver

1. Implement the interface in a new file, e.g. `services/provisioner/fly.ts`.
2. Add its `mode` string to the `ProvisionerMode` union in `types.ts`.
3. Extend the factory in `provisioner/index.ts` to construct your driver when `PROVISIONER_MODE` matches.
4. Add the matching branch to the installer's mode picker (`packages/installer/src/app.tsx`) + env-var docs.
5. Add compose services if your driver needs extras.

The rest of the server talks to the driver only through the interface — no other changes.

## Inner hosting provider contract

```ts
// packages/server/src/services/providers/types.ts
interface HostingProvider {
  readonly name: "docker" | "digitalocean" | "dokploy";

  validate(config: Record<string, unknown>): ProviderConfigCheck;
  verify(config: Record<string, unknown>): Promise<ProviderConfigCheck>;
  provision(config, { userId, name }): Promise<ProvisionResult>;
  destroy(config, hostingNodeId): Promise<void>;
}
```

Adding a new inner provider: implement the interface, register it in `services/providers/index.ts`, add the provider name to the `provider` enum in `db/schema.ts`.

## Docker socket posture

`PROVISIONER_MODE=docker` mounts `/var/run/docker.sock` into the `agenthub-server` container. This is a real security surface — the server gets root-equivalent access to the host Docker daemon. To prevent accidents:

- `DockerDriver.assertNoHostSocket()` refuses to start if the socket is mounted UNLESS `AGENTHUB_ALLOW_SOCKET_MOUNT=true` is explicitly set in env.
- The installer sets that flag automatically for `docker` mode in `compose/docker-compose.yml`.
- Users who want zero-socket-mount security pick `dokploy-local` or `dokploy-remote` where Dokploy owns the daemon and AgentHub talks API.

## Storage model

- **Platform state** — SQLite at `/data/agenthub.db`. Tables: `users`, `sessions`, `session_tokens`, `user_credentials`, `infrastructure_configs`, `deployments`, `backup_runs`.
- **Provider secrets** — Infisical, never SQLite. Cloudflare tokens, B2 keys, DigitalOcean tokens, Dokploy API tokens all at `/users/{userId}/...` paths. `infrastructure_configs.config` keeps only non-secret metadata (zoneId, hostIp, etc.).
- **Per-user workspace `/home/coder`** — Docker named volume `agenthub-home-{userId}`. Persists across session ends (destroy with `keepVolume: true`). Only purged when a user is explicitly deleted.
- **Let's Encrypt certs** — `traefik-letsencrypt` Docker volume.
- **Infisical's own data** — `infisical-pg-data` + `infisical-redis-data` volumes. Backup separately; restoring requires matching `INFISICAL_ENCRYPTION_KEY`.

## Install flow

1. `./scripts/install.sh` calls `pnpm install --filter @agenthub/installer`
2. Builds `agenthubv2-server:local` + `agenthubv2-workspace:local` unless the caller pinned published tags
3. Installer renders `compose/.env` with random secrets + user-provided config
4. `docker compose pull --ignore-pull-failures` pulls registry images (Postgres, Redis, Traefik, Infisical). Locally-tagged images are skipped gracefully.
5. `docker compose up -d --pull never` brings the stack up with the cached images. AgentHub's `SecretStore` boots as `UnconfiguredStore` because no `INFISICAL_CLIENT_*` values exist yet.
6. **Infisical bootstrap** (`packages/installer/src/lib/infisical-bootstrap.ts`):
   a. Poll `http://localhost:8080/api/status` for up to 180s
   b. `npx -y @infisical/cli bootstrap --domain --email --password --organization --output json` creates the admin user, org, and an instance-admin machine identity; returns a bearer JWT
   c. `POST /api/v1/auth/universal-auth/identities/{id}` attaches universal-auth to that identity
   d. `POST .../client-secrets` generates a client secret; `GET .../identities/{id}` reads the clientId
   e. `POST /api/v2/workspace` creates a default project; identity is auto-added as a member
   f. Installer writes `INFISICAL_PROJECT_ID / CLIENT_ID / CLIENT_SECRET` back to `compose/.env`
7. `docker compose up -d --force-recreate agenthub-server` restarts the server with the real secret-store config
8. Installer prints BOTH admin credential sets (AgentHub + Infisical)

## Request flow: creating a session

1. User → browser → `POST /api/sessions { name, repo?, prompt? }`
2. Server generates `agentToken`, writes a `creating` row to `sessions`
3. Server calls `provisioner.create(...)` — driver creates/starts the workspace container with env `{ AGENT_TOKEN, PORTAL_URL, SESSION_ID, AGENT_PORT }` + volume mounted at `/home/coder`
4. Driver returns `WorkspaceRef`. Server persists `workspaceId`, `providerId`, `workspaceHost`
5. Server waits on `provisioner.waitForIp(ref)` (Docker: inspect network settings; Dokploy: service DNS name)
6. Server dials `ws://{ip}:9876?token={agentToken}`
7. Agent in the workspace validates the token (reads `AGENT_TOKEN` env) → accepts the connection
8. Session status flips to `active`
9. Browser opens `/ws/sessions/{id}/terminal` → server proxies to `ws://{ip}:7681/ws` (ttyd inside the workspace)

There is no `/api/agent/register` self-registration endpoint. The server knows the IP from the driver; the container never self-reports.

## Request flow: backup save

1. User → `POST /api/user/backup/save`
2. Route fetches B2 creds from Infisical (`/users/{userId}/b2`)
3. Calls `sessionManager.backupViaAgent(userId, "save", { b2KeyId, b2AppKey, b2Bucket, subdir })`
4. SessionManager finds the user's active session, grabs that session's agent WS
5. Sends `{type: "backup", op: "save", requestId, params}` over the agent WS
6. Agent validates params (char allowlist), writes a tmp rclone.conf (0600), runs `rclone sync /home/coder b2:{bucket}/{subdir}` with argv-array spawn (no shell)
7. On completion, agent replies `{type: "backup-result", requestId, ok, bytes, fileCount, error?}`
8. Server correlates by `requestId`, updates the `backup_runs` row, returns to the HTTP caller

Backup requires an active session — if the user has none, the route returns a clear error instructing them to start one.

## Session lifecycle

```
creating ─▶ starting ─▶ active ─▶ idle ─▶ active ─▶ … ─▶ completed
             (failed)              (agent disconnected,
                                    workspace still running)
```

Transitions come from agent WS messages (`type: "status"`) or from driver `status()` polls when the agent connection is lost.

## Auth

- Cookie-based session tokens (`session_token`, httpOnly, sameSite=Lax, 30-day TTL)
- Agent-to-server: `Authorization: AgentToken {per-session-agentToken}`. One workspace → one session → one token.
- Admin role gates `/api/admin/*`. Single-tenant platform; no tenant isolation in code, just user isolation.

## Terminal protocol

ttyd uses ASCII type bytes for framing. Server → browser:
- `0x30` ('0') — terminal output
- `0x31` ('1') — window title
- `0x32` ('2') — preferences

Browser → server:
- `0x30` — terminal input
- `0x31` — resize (JSON `{columns, rows}`)

The proxy sends `{"AuthToken":""}` immediately after the ttyd WebSocket opens. Binary payloads are passed through verbatim; only the first byte is inspected for routing.

## Observability

Logs to stdout — `docker compose logs <service>` is the intended inspection tool. The server emits high-signal console messages for session state changes, provisioner actions, agent WS connects/disconnects, and Infisical errors.

Metrics / tracing are deliberately out of scope for v2. Users who want them can layer Grafana/Loki on top of the compose stack.

