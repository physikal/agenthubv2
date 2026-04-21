# Installing AgentHub v2 (for coding agents)

Target audience: Claude Code, OpenClaw, Hermes, or any other coding agent driving AgentHub's installer through env vars + non-interactive flags. If you're a human, read [humans.md](./humans.md) instead.

## One command

```bash
AGENTHUB_MODE=docker \
AGENTHUB_DOMAIN=localhost \
AGENTHUB_ADMIN_PASSWORD=change-me-please \
npx agenthub-install --non-interactive
```

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Install succeeded. URL + admin credentials printed to stdout. |
| 2 | Required env var missing. Names printed to stderr. |
| 3 | Install failed (Docker error, compose error, network). Reason printed to stderr. |

## Every env var

### Required

| Var | Values | Notes |
|---|---|---|
| `AGENTHUB_MODE` | `docker` &#124; `dokploy-local` &#124; `dokploy-remote` | Workspace provisioner |
| `AGENTHUB_DOMAIN` | hostname or `localhost` | Where AgentHub is reachable |
| `AGENTHUB_ADMIN_PASSWORD` | any string | If omitted, a random one is generated and printed at the end |

If `AGENTHUB_DOMAIN != localhost`, you MUST also set:

| Var | Values |
|---|---|
| `AGENTHUB_TLS_EMAIL` | any email |

If `AGENTHUB_MODE=dokploy-remote`, you MUST also set:

| Var | Notes |
|---|---|
| `AGENTHUB_DOKPLOY_URL` | e.g. `https://dokploy.example.com` |
| `AGENTHUB_DOKPLOY_API_TOKEN` | created in Dokploy profile settings |
| `AGENTHUB_DOKPLOY_PROJECT_ID` | target project where workspaces are created |
| `AGENTHUB_DOKPLOY_ENVIRONMENT_ID` | target environment inside the project |

### Optional overrides

| Var | Default | Purpose |
|---|---|---|
| `AGENTHUB_SERVER_IMAGE` | `ghcr.io/physikal/agenthubv2-server:latest` | Pin a specific server version |
| `AGENTHUB_WORKSPACE_IMAGE` | `ghcr.io/physikal/agenthubv2-workspace:latest` | Pin a specific workspace version |

Everything else (Infisical DB/Redis passwords, encryption keys, auth secrets) is generated randomly per install and written to `.env`.

## Minimal flow

```bash
# 1. Verify prereqs (install will re-check, but good hygiene):
docker info >/dev/null && docker compose version >/dev/null

# 2. Install:
AGENTHUB_MODE=docker AGENTHUB_DOMAIN=localhost AGENTHUB_ADMIN_PASSWORD=s3cret \
  npx agenthub-install --non-interactive

# 3. Capture the URL from stdout. By design, the final 3 lines are:
#    AgentHub is up at <URL>
#    Admin user: admin
#    Admin password: <password>

# 4. Verify health:
curl -sf "$URL/api/health"   # expects {"status":"ok"}
```

## Post-install config (programmatic)

All post-install config is REST over the admin session cookie. Log in to get a cookie:

```bash
curl -sf -c cookies.txt -X POST "$URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$AGENTHUB_ADMIN_PASSWORD\"}"
```

Then the usual CRUD against:

- `GET/POST/PUT/DELETE /api/infra` — manage Cloudflare / Docker / DigitalOcean / Dokploy integrations
- `GET/PUT/DELETE /api/user/backup` — Backblaze B2 config
- `POST /api/sessions` — create a workspace session
- `GET /api/sessions/:id` — poll status
- `POST /api/sessions/:id/end` — destroy the session

## Self-verification after install

Recommended smoke test agents should run before reporting success:

```bash
# a) health
test "$(curl -s $URL/api/health)" = '{"status":"ok"}'

# b) services all running
docker compose -f path/to/docker-compose.yml ps --format json | \
  jq -r '.[] | select(.State != "running") | .Service' | \
  wc -l | grep -q '^0$'

# c) login works
curl -sf -X POST $URL/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$AGENTHUB_ADMIN_PASSWORD\"}"
```

If all three pass, the stack is genuinely up.
