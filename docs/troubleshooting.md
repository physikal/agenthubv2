# AgentHub v2 — Troubleshooting

Organized by the error message / symptom you'd see. Each entry tells you the root cause and the fix.

## Install-time failures

### `pnpm not found` or `docker not found`

Missing prereq. See [install/humans.md](install/humans.md) prereqs.

### `Port 80 in use` / `Port 443 in use`

Something else on the host is listening on 80 or 443. Traefik can't bind, so the install aborts.

```bash
sudo ss -lntp | grep -E ':80 |:443 '
```

Common culprits: Apache, Nginx, Caddy, another Docker Compose stack with its own Traefik, `nginx-proxy-manager`. Stop the offender (`sudo systemctl stop apache2` / etc.) and re-run.

### `spawn docker ENOENT`

Docker CLI is installed but the daemon isn't running (or your user isn't in the `docker` group).

```bash
sudo systemctl start docker         # start daemon
sudo usermod -aG docker "$USER"     # grant group; log out and back in
```

### Install stuck in `pulling images` for minutes

First-time pull of `infisical/infisical:latest-postgres` is large (~3.9 GB) and can take 5+ minutes on a slow connection. It's not hung; `docker ps` shows the images appearing. If you're sure it's dead:

```bash
docker ps --all --filter "name=agenthub-" --format "{{.Names}} {{.Status}}"
docker compose -f compose/docker-compose.yml logs --tail 20
```

### `docker compose up -d --pull never exited 1` → `No such image: agenthubv2-server:local`

Your local image build failed earlier. Rebuild:

```bash
docker build --no-cache -f docker/Dockerfile.server -t agenthubv2-server:local .
docker build --no-cache -f docker/Dockerfile.agent-workspace -t agenthubv2-workspace:local .
./scripts/install.sh --non-interactive   # resume
```

### `Infisical bootstrap succeeded but returned no identity.credentials.token`

Infisical's API shape drifted or you're pointing at an already-bootstrapped instance. Try:

```bash
# Reset Infisical to a fresh state (DESTROYS any existing secrets):
docker compose -f compose/docker-compose.yml down -v
# Reinstall:
./scripts/install.sh --non-interactive
```

### Install completes but web UI returns `502 Bad Gateway`

Traefik is up but the server behind it isn't. Usually the agenthub-server image has a startup error.

```bash
docker compose -f compose/docker-compose.yml logs agenthub-server --tail 50
```

## Runtime failures

### `503 Secret store not configured` when saving Cloudflare/B2 config

Infisical bootstrap didn't complete, or `INFISICAL_CLIENT_ID` / `INFISICAL_CLIENT_SECRET` in `compose/.env` are empty.

```bash
grep ^INFISICAL_ compose/.env
# If CLIENT_ID or CLIENT_SECRET are empty:
./scripts/install.sh --non-interactive   # re-runs bootstrap idempotently
```

### `admin` login fails with valid password

The admin was seeded with a different password than what's in `.env`. This happens when:
- You changed `compose/.env` after install without recreating the DB
- You installed multiple times without wiping volumes

```bash
# Option 1 — use the password the DB was actually seeded with:
grep ^AGENTHUB_ADMIN_PASSWORD= compose/.env | cut -d= -f2

# Option 2 — nuke and reinstall (DESTROYS all AgentHub data):
docker compose -f compose/docker-compose.yml down -v
./scripts/install.sh --non-interactive
```

### Session stuck in `Connecting to agent...` forever

The workspace container started but the agent WebSocket never connects. Three possible causes:

**a. Workspace container crashed on startup.**

```bash
docker ps -a --format '{{.Names}} {{.Status}}' | grep agenthub-ws-
docker logs $(docker ps -a --format '{{.Names}}' | grep agenthub-ws- | head -1) --tail 30
```

If you see `Cannot find package 'ws'`, the workspace image was built without a flat `node_modules`. Rebuild:
```bash
docker build --no-cache -f docker/Dockerfile.agent-workspace -t agenthubv2-workspace:local .
```

**b. Network isolation.** The server can't reach the workspace on the `agenthub` bridge network. This is rare but check:
```bash
docker network inspect agenthub | jq -r '.[0].Containers | to_entries[] | "\(.value.Name) \(.value.IPv4Address)"'
```

### Session reaches `active` but backup returns `No active workspace session`

The session went `active` then `idle` (agent disconnected). Backup requires the agent WS to be connected.

```bash
# Wait for agent to reconnect (auto-retries), or:
# Open the session in a browser (the terminal proxy will restart the agent path)
```

### `Failed to bootstrap instance: CallBootstrapInstance: ... connection reset by peer`

Infisical's Postgres migration is still running. First boot can take 30-60s.

```bash
docker compose -f compose/docker-compose.yml logs infisical --tail 30
# wait for "Server started on port 8080"
./scripts/install.sh --non-interactive   # re-runs bootstrap idempotently
```

### `Let's Encrypt cert fails` / `TLS handshake error`

Usually DNS hasn't propagated yet or the host isn't reachable from the internet on port 80.

```bash
# Verify from outside the host:
curl -v http://your-domain/ 2>&1 | head -20

# Traefik's ACME log
docker compose -f compose/docker-compose.yml logs traefik --tail 50 | grep -iE 'acme|cert|error'
```

Workaround: install with `AGENTHUB_DOMAIN=localhost` for a local-only HTTP setup, then redo with your real domain once DNS is ready.

## Data / state

### How do I wipe everything and start over?

```bash
cd path/to/agenthubv2
docker compose -f compose/docker-compose.yml down -v
docker volume ls -q | grep agenthub-home- | xargs -r docker volume rm
rm -f compose/.env
./scripts/install.sh --non-interactive
```

### How do I back up the AgentHub database itself?

The platform's own SQLite lives in the `agenthub-data` Docker volume. To back it up:

```bash
docker run --rm -v agenthub_agenthub-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/agenthub-data-$(date +%F).tgz -C /data .
```

Restore: reverse the tar.

Infisical's Postgres is in `agenthub_infisical-pg-data`. Backup separately; restoring requires matching the `INFISICAL_ENCRYPTION_KEY` in `.env`.

### How do I rotate Infisical creds?

Log into `https://secrets.<domain>/` as the Infisical admin, create a new machine identity + universal-auth secret, paste into `compose/.env`:

```
INFISICAL_CLIENT_ID=<new>
INFISICAL_CLIENT_SECRET=<new>
```

Then:
```bash
docker compose -f compose/docker-compose.yml up -d --force-recreate agenthub-server
```

## Debugging tips

- Every service logs to stdout; `docker compose logs <service>` is your primary tool
- The installer writes `compose/.env` with mode 0600; all secrets are there
- The full E2E test script at `scripts/e2e-full.js` runs 21 app-logic checks plus automatic cleanup — use it as a full-surface sanity test. Copy it into the server container and run:
  ```bash
  docker cp scripts/e2e-full.js agenthub-agenthub-server-1:/tmp/e2e.js
  docker exec -e ADMIN_PASSWORD=<pw> agenthub-agenthub-server-1 node /tmp/e2e.js
  ```
  The script is self-cleaning: any infra configs, backup credentials, or sessions it creates are removed before exit, so re-runs start clean and a freshly-installed user never sees test fixtures.
- For session-specific debugging: `docker logs agenthub-ws-<workspace-id>` gives the agent-side view

## Still stuck?

Open an issue at https://github.com/physikal/agenthubv2/issues with:
- the output of `docker compose -f compose/docker-compose.yml ps`
- relevant log tails (`logs agenthub-server --tail 50`, `logs infisical --tail 50`)
- your `compose/.env` **with every value masked except the key names**
- the install command you ran
