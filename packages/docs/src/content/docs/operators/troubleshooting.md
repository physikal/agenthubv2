---
title: Troubleshooting
description: Common failure modes and what to do about them.
---

This is the in-app quick reference. For the exhaustive list — every error message, every root cause — see the canonical file in the repo: [`docs/troubleshooting.md`](https://github.com/physikal/agenthubv2/blob/main/docs/troubleshooting.md). The content below is the same material, reframed for the user who's actually in front of a running UI.

## Session stuck in `Connecting to agent...` forever

The workspace container started but its agent daemon never checked back in. Three possible causes:

### a. The workspace container crashed on startup

Check logs from the host:

```bash
docker ps -a --format '{{.Names}} {{.Status}}' | grep agenthub-ws-
docker logs $(docker ps -a --format '{{.Names}}' | grep agenthub-ws- | head -1) --tail 30
```

A common failure is `Cannot find package 'ws'`, which means the workspace image build didn't land a flat `node_modules` for the agent daemon. Rebuild:

```bash
docker build --no-cache -f docker/Dockerfile.agent-workspace -t agenthubv2-workspace:local .
```

Then end the stuck session and create a new one.

### b. The agent daemon can't reach the server

The agent connects back to the server on the `agenthub` bridge network. Confirm that network exists and contains both containers:

```bash
docker network inspect agenthub | jq -r '.[0].Containers | to_entries[] | "\(.value.Name) \(.value.IPv4Address)"'
```

You should see both `agenthub-server` and `agenthub-ws-<id>`. If the workspace isn't on the network, something's off with the provisioner config — check `compose/.env` for `AGENTHUB_DOCKER_NETWORK=agenthub`.

### c. Token mismatch

If an older workspace image was built before a token-format change, the agent inside it won't match the server's verification. Rebuild the workspace image (same command as (a)) to land current code.

## `503 Secret store not configured` when saving an integration

Infisical bootstrap didn't complete, or the credentials didn't make it into the server's env. Check:

```bash
grep ^INFISICAL_ compose/.env
```

If `CLIENT_ID` or `CLIENT_SECRET` are empty, re-run the installer — it's idempotent and will bootstrap if bootstrap wasn't done:

```bash
./scripts/install.sh --non-interactive
```

## Backup returns `No active workspace session`

Backups run inside the workspace container, so you need one running. Either:

- Start a session on the [Sessions page](/docs/web-ui/sessions/), then retry the backup, **or**
- If a session is showing `idle`, just open its terminal — the agent will reconnect and the session flips back to `active`, at which point backup works.

## Web UI returns `502 Bad Gateway`

Traefik is up but the server container isn't. From the host:

```bash
docker compose -f compose/docker-compose.yml logs agenthub-server --tail 50
```

Most common causes:

- Missing `INFISICAL_CLIENT_*` — server refuses to start. Re-run installer.
- Migration failure — usually a breaking DB change. If this happens after an update, read the error, fix it, `docker compose up -d --force-recreate agenthub-server`.
- Port 3000 occupied inside the container — shouldn't happen unless you're doing something unusual.

## Let's Encrypt cert won't issue

Usually DNS hasn't propagated yet or port 80 isn't reachable from the public internet on your domain.

```bash
# From outside the host — confirm DNS points at you and port 80 reaches Traefik
curl -v http://your-domain/ 2>&1 | head -20

# Check Traefik's ACME log for the actual error
docker compose -f compose/docker-compose.yml logs traefik --tail 50 | grep -iE 'acme|cert|error'
```

Workaround for the impatient: reinstall with `AGENTHUB_DOMAIN=localhost` to skip Let's Encrypt entirely, then redo the install with your real domain once DNS is resolving.

## `admin` login fails with the password I was printed

Common path: you changed `compose/.env` after install without recreating the DB. The seeded admin password in SQLite doesn't update from `.env` on re-read; it only matters at first boot.

- **Option 1 (non-destructive):** log in with whatever password is currently in `compose/.env`:
  ```bash
  grep ^AGENTHUB_ADMIN_PASSWORD= compose/.env | cut -d= -f2
  ```
- **Option 2 (destructive):** nuke data and re-install:
  ```bash
  docker compose -f compose/docker-compose.yml down -v
  ./scripts/install.sh --non-interactive
  ```

Option 2 deletes all users, sessions, and integrations.

## How do I wipe everything and start over?

The **nuclear** reset:

```bash
cd <install-dir>
docker compose -f compose/docker-compose.yml down -v
docker volume ls -q | grep agenthub-home- | xargs -r docker volume rm
rm -f compose/.env
./scripts/install.sh --non-interactive
```

This destroys:

- All platform state (users, sessions, deployments, backups, integration metadata)
- All secrets in Infisical
- Every user's home volume
- Traefik's certificate cache
- `compose/.env` — the installer regenerates it

## How do I rotate Infisical creds?

1. Log into the [Infisical console](/docs/infisical/console/).
2. **Access Control → Identities** — create a new machine identity with the same project access as the current one.
3. **Access Control → Identities → (new one) → Authentication** — configure universal-auth, generate a new client secret, copy the clientId.
4. Edit `compose/.env`:
   ```
   INFISICAL_CLIENT_ID=<new>
   INFISICAL_CLIENT_SECRET=<new>
   ```
5. Recreate the server:
   ```bash
   docker compose -f compose/docker-compose.yml up -d --force-recreate agenthub-server
   ```
6. Confirm via `agenthub logs agenthub-server` that `SecretStore initialized` shows in the logs.

Once verified, delete the old identity in the Infisical console.

## Still stuck?

File an issue: https://github.com/physikal/agenthubv2/issues

Include:
- `docker compose -f compose/docker-compose.yml ps`
- Relevant log tails (`docker compose logs agenthub-server --tail 50`, `docker compose logs infisical --tail 50`)
- Your `compose/.env` **with every value masked** except the key names
- The install command you ran
