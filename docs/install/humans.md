# Installing AgentHub v2 (for humans)

This walks through installing AgentHub v2 on one host. It takes about 10 minutes.

## Prerequisites

One host running Linux with:

- **Docker 24+** (`docker info` works as the user you'll run the installer as)
- **Docker Compose plugin** (`docker compose version` works)
- **Ports 80 and 443 free** (Traefik binds these for TLS)
- **2 GB RAM, 10 GB disk** minimum

DNS is optional — you can install with `DOMAIN=localhost` and the stack works over HTTP on the local host. For real users on a public domain, point an A record at the host's IP *before* installing so Let's Encrypt's ACME challenge can complete.

## Install

```bash
npx agenthub-install
```

That's it. The installer walks through:

1. **Prerequisite check.** Verifies Docker, Compose, and that ports 80/443 are free.
2. **Provisioner choice.** Pick one:
   - **Local Docker** — AgentHub runs workspace containers on the same host. Simplest.
   - **Bundled Dokploy** — spins up Dokploy alongside AgentHub. Use this if you want Dokploy's UI for managing workspaces.
   - **Remote Dokploy** — point AgentHub at an existing Dokploy instance. You'll be asked for its URL, API token, project ID, and environment ID.
3. **Domain.** `localhost` for local-only, a real hostname otherwise.
4. **TLS email.** Only asked if you picked a non-localhost domain. Used by Let's Encrypt for certificate expiry notifications.
5. **Admin password.** Leave blank to auto-generate one (printed at the end).
6. **Confirm → install.** The installer writes `.env` to the compose directory, pulls images, and runs `docker compose up -d`.

When it's done, you'll see:

```
AgentHub v2 is up.
URL: https://your-domain.example
Admin user: admin
Admin password: <generated or what you typed>
```

Visit the URL, log in, and you're in.

## What just got installed

A `docker compose` stack with these services:

| Service | Role |
|---|---|
| `traefik` | Reverse proxy, TLS termination via Let's Encrypt (ACME tls-alpn-01) |
| `infisical` + `infisical-postgres` + `infisical-redis` | Secret store for provider credentials |
| `agenthub-server` | The platform itself |
| `dokploy` + deps (only if you picked **Bundled Dokploy**) | Workspace orchestration |

All of them speak to each other on an internal `agenthub` bridge network. Only ports 80 and 443 are exposed on the host.

## Post-install configuration

Log in as `admin` and change your password. Then:

- **Cloudflare DNS** (optional) — Settings → Infrastructure → add a Cloudflare config so the `agentdeploy` MCP can create DNS records when your agents deploy apps.
- **Backblaze B2 backups** (optional) — Settings → Backups → enter B2 key/appkey/bucket to enable per-user home directory backups.
- **Deploy targets** — Add Docker/DigitalOcean/Dokploy configs under Infrastructure for the agents to deploy INTO.

## Upgrading

```bash
cd ~/.agenthub-install
docker compose pull
docker compose up -d
```

The installer writes the compose bundle to a predictable location on first install; re-running the installer with `npx agenthub-install` from the same host will reuse it.

## Uninstalling

```bash
cd path/to/compose/bundle
docker compose down -v           # stops containers + drops all volumes
# Workspace volumes persist across session ends by design; add them explicitly:
docker volume ls | grep agenthub-home- | awk '{print $2}' | xargs -r docker volume rm
```

That removes every byte AgentHub created except the `.env` file, which you can delete by hand.

## Troubleshooting

**Installer exits with `Port 80 in use`.**
Something else on the host is listening on 80 or 443. `sudo ss -lntp | grep -E ':80 |:443 '` to find it. Common culprits: Apache, Nginx, Caddy, another reverse proxy.

**Let's Encrypt cert fails.**
Check Traefik logs: `docker compose logs traefik`. Usually means DNS hasn't propagated or the host isn't reachable from the internet on port 80.

**`admin` login fails.**
Password is in the installer's final output. If you closed that terminal, grab it from `.env`: `grep AGENTHUB_ADMIN_PASSWORD .env`. If you left the field blank AND didn't save the output, the server generated one at first boot — reset it with `docker compose exec agenthub-server node -e "..."` or remove the seed row from SQLite and restart to get a fresh password.

**Workspace won't start / agent never connects.**
`docker compose logs agenthub-server` shows the provisioner's side. `docker ps | grep agenthub-ws-` shows running workspaces. Inspect one: `docker logs <container>` — the workspace entrypoint is chatty about what's happening.

**Infisical is stuck "starting".**
First boot runs Postgres migrations — can take 30 seconds. If it's longer, check `docker compose logs infisical`. Re-running `docker compose up -d` is safe; the server waits on Infisical's healthcheck.
