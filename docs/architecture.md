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
│                              │     └─────────────────────────────────┘                             │
│                              │     volume: agenthub-home-{userId}:/home/coder (persistent)         │
│                              │                                                                     │
│                              └─▶ infisical (:8080, at secrets.{DOMAIN})                            │
│                                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
                      ▲                                                          ▼
                      │ user browser                                   agent-driven deploys via MCP
                      │                                                  (docker / digitalocean / dokploy)
```

## Two independent provisioner layers

This distinction is the most important thing to understand about AgentHub v2:

1. **Outer:** how AgentHub spins up a workspace container FOR each session. Implemented by `services/provisioner/*`. Config: `PROVISIONER_MODE` env var.
2. **Inner:** how an agent deploys ITS apps from inside a workspace. Implemented by `services/providers/*` + the `agentdeploy` MCP. Config: user-created `infra` records.

Both layers support Docker and Dokploy, but they're completely separate code paths with separate drivers. A user can run AgentHub with `PROVISIONER_MODE=docker` (outer = Docker) and deploy their agent's apps to a DigitalOcean droplet (inner = DigitalOcean) in the same install.

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

1. Implement the interface in a new file, e.g. `services/provisioner/fly.ts` for Fly.io.
2. Add its `mode` string to the `ProvisionerMode` union in `types.ts`.
3. Extend the factory in `provisioner/index.ts` to construct your driver when `PROVISIONER_MODE` matches.
4. Add the matching branch to the installer's mode picker (`packages/installer/src/app.tsx`) and env-var documentation.
5. Add a row to the compose bundle if your driver needs extra services.

The rest of the server talks to the driver only through the interface — no other code changes should be needed.

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

Adding a new inner provider is the same shape: implement the interface, register it in `services/providers/index.ts`, and add the provider name to the `provider` enum in `db/schema.ts`.

## Storage model

- **Platform state** — SQLite at `/data/agenthub.db`. Tables: `users`, `sessions`, `session_tokens`, `user_credentials`, `infrastructure_configs`, `deployments`, `backup_runs`.
- **Provider secrets** — Infisical. Never SQLite. Cloudflare tokens, B2 keys, DigitalOcean tokens, Dokploy API tokens all live at `/users/{userId}/...` paths.
- **Per-user workspace `/home/coder`** — Docker named volume `agenthub-home-{userId}`. Persists across session ends (destroy with `keepVolume: true`). Only purged when a user is explicitly deleted.
- **Let's Encrypt certs** — `traefik-letsencrypt` Docker volume.

## Request flow: creating a session

1. User → browser → `POST /api/sessions { name, repo?, prompt? }`
2. Server generates `agentToken`, writes a `creating` row to `sessions`.
3. Server calls `provisioner.create(...)`. Driver creates/starts the container.
4. Driver returns `WorkspaceRef`. Server persists `workspaceId`, `providerId`, `workspaceHost`.
5. Server waits on `provisioner.waitForIp(ref)`.
6. Server dials the agent daemon on `ws://{ip}:9876?token={agentToken}`.
7. When the agent WebSocket opens, session status becomes `active`.
8. Browser opens `/ws/sessions/{id}/terminal` → server proxies to `ws://{ip}:7681/ws` (ttyd inside the workspace).

No `/api/agent/register` — v1's self-registration endpoint is gone. The server knows the IP from the driver; the container never tells the server where it is.

## Session lifecycle

```
creating ─▶ starting ─▶ active ─▶ idle ─▶ active ─▶ … ─▶ completed
             (failed)              (agent disconnected,
                                    workspace still running)
```

Transitions come from agent WS messages (`type: "status"`) or from driver `status()` polls when the agent connection is lost.

## Auth

- Cookie-based session tokens (`session_token`, httpOnly, sameSite=Lax, 30-day TTL)
- Agent-to-server: `Authorization: AgentToken {per-session-agentToken}`. No shared token, no X-Vmid fallback. One workspace → one session → one token.
- Admin role gates `/api/admin/*`. Single-tenant platform; no tenant isolation in the code, just user isolation.

## Terminal protocol

ttyd uses ASCII type bytes for framing. Server → browser:
- `0x30` ('0') — terminal output
- `0x31` ('1') — window title
- `0x32` ('2') — preferences

Browser → server:
- `0x30` — terminal input
- `0x31` — resize (JSON `{columns, rows}`)

The proxy sends `{"AuthToken":""}` immediately after the ttyd WebSocket opens (ttyd expects a subprotocol auth handshake). Binary payloads are passed through verbatim; only the first byte is inspected for routing.

## Observability

Logs to stdout. No structured logger in v2 — `docker compose logs <service>` is the intended inspection tool. The server uses `console.log`/`console.warn` for high-signal events: session state changes, provisioner driver actions, agent WS connects/disconnects.

Metrics/tracing are deliberately out of scope for v2. A user who wants them can layer Grafana/Loki on top of the compose stack.

## Migration from v1

v2 is a fresh install — there's no migration path for v1 data. Reasons:

- v1 stores NFS paths in `sessions.lxc_vmid` which don't map to Docker volumes
- v1's `pool_containers` table has no v2 equivalent (warm pool dropped)
- v1's `userCredentials.backupConfig` JSON needs to land in Infisical

A defensive `DROP TABLE IF EXISTS pool_containers` runs on startup in case a v1 DB is accidentally mounted. `sessions` column rename is also handled. Nothing else is attempted.

The CLAUDE.md referenced v1 live URL (`agenthub.physhlab.com`) stays running as-is; v2 is a new deployment at a new URL.
