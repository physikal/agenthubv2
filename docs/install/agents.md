# Installing AgentHub v2 (for coding agents)

Target audience: Claude Code, OpenClaw, Hermes, or any other coding agent driving AgentHub's installer via env vars + `--non-interactive`. If you're a human, read [humans.md](./humans.md) instead.

## One-shot install

**One-liner** (pipes through bash, cleans up after itself):

```bash
curl -fsSL https://raw.githubusercontent.com/physikal/agenthubv2/main/scripts/quick-install.sh \
  | AGENTHUB_MODE=docker \
    AGENTHUB_DOMAIN=localhost \
    AGENTHUB_ADMIN_PASSWORD=change-me-please \
    bash -s -- --non-interactive
```

**Clone-first** (when the one-liner is blocked or you want to pin a ref):

```bash
git clone https://github.com/physikal/agenthubv2.git
cd agenthubv2
AGENTHUB_MODE=docker \
AGENTHUB_DOMAIN=localhost \
AGENTHUB_ADMIN_PASSWORD=change-me-please \
./scripts/install.sh --non-interactive
```

See [installer-flow.md](installer-flow.md) for the full step → env-var mapping and what happens under the hood during the "Installing..." phase.

`./scripts/install.sh` does:
1. `pnpm install --filter @agenthub/installer`
2. `docker build` both images locally (server + workspace) unless `AGENTHUB_SERVER_IMAGE` and `AGENTHUB_WORKSPACE_IMAGE` point at pre-built tags
3. Runs the installer, which pulls Infisical/Postgres/Redis/Traefik, brings up compose, bootstraps Infisical, force-recreates the server so it picks up the new secrets

## Exit codes

| Code | Meaning | Action |
|---|---|---|
| 0 | Install succeeded. URL + both credential sets printed to stdout. | Parse stdout, persist creds for later config calls. |
| 2 | Required env var missing. Names printed to stderr, one per line. | Set the missing vars and re-run. |
| 3 | Install failed (Docker error, compose error, Infisical bootstrap). | Read stderr for reason; common fixes in [troubleshooting.md](../troubleshooting.md). |

## Env vars

### Required

| Var | Values | Notes |
|---|---|---|
| `AGENTHUB_MODE` | `docker` \| `dokploy-local` \| `dokploy-remote` | Workspace provisioner mode. |
| `AGENTHUB_DOMAIN` | hostname or `localhost` | Where AgentHub is reachable. `localhost` gives HTTP-only; any other value triggers Let's Encrypt. |
| `AGENTHUB_ADMIN_PASSWORD` | any string, min 8 chars | AgentHub admin password. If omitted, a random one is generated and printed. |

### Required when `AGENTHUB_DOMAIN != localhost`

| Var | |
|---|---|
| `AGENTHUB_TLS_EMAIL` | Email for Let's Encrypt cert expiry notifications. |

### Required when `AGENTHUB_MODE=dokploy-remote`

| Var | |
|---|---|
| `AGENTHUB_DOKPLOY_URL` | e.g. `https://dokploy.example.com` |
| `AGENTHUB_DOKPLOY_API_TOKEN` | Created in Dokploy profile settings. |
| `AGENTHUB_DOKPLOY_PROJECT_ID` | Target project for workspace containers. |
| `AGENTHUB_DOKPLOY_ENVIRONMENT_ID` | Target environment inside the project. |

### Optional overrides

| Var | Default | Purpose |
|---|---|---|
| `AGENTHUB_SERVER_IMAGE` | `agenthubv2-server:local` (built by install.sh) | Pin to a published tag (e.g. `ghcr.io/physikal/agenthubv2-server:v2.0.0`). |
| `AGENTHUB_WORKSPACE_IMAGE` | `agenthubv2-workspace:local` (built by install.sh) | Pin to a published workspace-image tag. |

Everything else (Infisical DB/Redis passwords, encryption keys, auth secrets) is generated randomly per install and written to `compose/.env`. The Infisical admin password is also auto-generated and printed to stdout — capture it before your process exits.

## Minimal flow (bash)

```bash
# 1. Prereq sanity
docker info >/dev/null || { echo "no docker"; exit 1; }
docker compose version >/dev/null || { echo "no compose plugin"; exit 1; }

# 2. Install
AGENTHUB_MODE=docker \
AGENTHUB_DOMAIN=localhost \
AGENTHUB_ADMIN_PASSWORD=s3cret-change-me \
./scripts/install.sh --non-interactive > /tmp/ah-install.log 2>&1
[ $? -eq 0 ] || { cat /tmp/ah-install.log; exit 3; }

# 3. Parse the "AgentHub is up at …" URL + admin passwords
URL=$(grep -oE 'AgentHub is up at \S+' /tmp/ah-install.log | awk '{print $NF}')
AH_PW=$(grep -oE 'Admin password: \S+' /tmp/ah-install.log | head -1 | awk '{print $NF}')
INF_PW=$(grep -oE 'Admin password: \S+' /tmp/ah-install.log | tail -1 | awk '{print $NF}')

# 4. Health
test "$(curl -sf $URL/api/health)" = '{"status":"ok"}' || exit 3

# 5. Log in
COOKIE=$(curl -sf -X POST "$URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -H "Origin: $URL" \
  -d "{\"username\":\"admin\",\"password\":\"$AH_PW\"}" \
  -D /tmp/ah-headers > /dev/null && grep -i set-cookie /tmp/ah-headers | cut -d: -f2-)
```

## Retrieving credentials after the fact

If your process lost the stdout:

```bash
# AgentHub admin password — in .env
grep ^AGENTHUB_ADMIN_PASSWORD= compose/.env | cut -d= -f2

# Infisical admin password — NOT in .env (only ever printed once).
# If lost, rotate by logging into AgentHub as admin and creating a new
# Infisical machine identity via the Infisical UI at secrets.<domain>.
# Then paste the new clientId/clientSecret into compose/.env:
#   INFISICAL_CLIENT_ID=…
#   INFISICAL_CLIENT_SECRET=…
# And recreate the server:
docker compose -f compose/docker-compose.yml up -d --force-recreate agenthub-server
```

## Post-install config (programmatic)

All post-install config is REST over the admin session cookie. Typical agent flow:

```bash
# Log in, save cookie
curl -sf -c /tmp/cookies -X POST "$URL/api/auth/login" \
  -H 'Content-Type: application/json' -H "Origin: $URL" \
  -d "{\"username\":\"admin\",\"password\":\"$AH_PW\"}"

# Add Cloudflare DNS infra (secrets go to Infisical)
curl -sf -b /tmp/cookies -X POST "$URL/api/infra" \
  -H 'Content-Type: application/json' -H "Origin: $URL" \
  -d '{
    "name": "cloudflare-main",
    "provider": "cloudflare",
    "config": {"apiToken": "cf_xxx", "zoneId": "zone_yyy"}
  }'

# Add B2 backups
curl -sf -b /tmp/cookies -X PUT "$URL/api/user/backup" \
  -H 'Content-Type: application/json' -H "Origin: $URL" \
  -d '{"b2KeyId":"0001abc","b2AppKey":"K001xyz","b2Bucket":"my-backups"}'

# Create a session
SESSION=$(curl -sf -b /tmp/cookies -X POST "$URL/api/sessions" \
  -H 'Content-Type: application/json' -H "Origin: $URL" \
  -d '{"name":"dev"}' | jq -r .id)

# Poll until active (up to 60s)
for i in $(seq 1 30); do
  STATUS=$(curl -sf -b /tmp/cookies "$URL/api/sessions/$SESSION" | jq -r .status)
  [ "$STATUS" = "active" ] && break
  [ "$STATUS" = "failed" ] && { echo "session failed"; exit 3; }
  sleep 2
done

# Trigger a backup (requires an active session)
curl -sf -b /tmp/cookies -X POST "$URL/api/user/backup/save" \
  -H "Origin: $URL"
```

All endpoints require `Origin: $URL` on state-changing methods (CSRF guard).

## Self-verification smoke test

Agents should run these three checks before reporting success:

```bash
# a) Health endpoint
test "$(curl -sf $URL/api/health)" = '{"status":"ok"}'

# b) All 5 compose services running
docker compose -f compose/docker-compose.yml ps --format json | \
  jq -r 'select(.State != "running") | .Service' | \
  { ! grep -q . ; }  # exits 0 if empty (all running)

# c) Login works with the seeded admin password
curl -sf -X POST "$URL/api/auth/login" \
  -H 'Content-Type: application/json' -H "Origin: $URL" \
  -d "{\"username\":\"admin\",\"password\":\"$AH_PW\"}" | \
  jq -e '.role == "admin"' > /dev/null
```

All three pass → stack is genuinely up. Anything else is a premature "done."

## Session lifecycle quick reference

A session goes through: `creating` → `starting` → `active` → (`idle` ↔ `active`) → `completed`.

- `creating`: server is writing the DB row
- `starting`: driver is provisioning the workspace container
- `active`: workspace is up AND agent WS is connected — this is the "you can use it" state
- `idle`: agent disconnected but workspace container still running (transient — server will reconnect automatically if agent comes back)
- `completed` / `failed`: terminal states

Create → `active` typically takes 5-15 seconds on Docker mode. Poll with backoff.
