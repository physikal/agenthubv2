# Installer flow

Visual reference for what happens when you run `./scripts/install.sh` (or the one-liner that wraps it). If you're writing an agent that drives this headless, use this to understand which env var answers which prompt.

## One-liner (interactive)

```bash
curl -fsSL https://raw.githubusercontent.com/physikal/agenthubv2/main/scripts/quick-install.sh | bash
```

This downloads `quick-install.sh`, verifies prereqs, clones the repo to `./agenthubv2`, and hands off to `./scripts/install.sh`. The TUI starts automatically.

## One-liner (headless / agent-driven)

```bash
curl -fsSL https://raw.githubusercontent.com/physikal/agenthubv2/main/scripts/quick-install.sh \
  | AGENTHUB_MODE=docker \
    AGENTHUB_DOMAIN=localhost \
    AGENTHUB_ADMIN_PASSWORD=change-me \
    bash -s -- --non-interactive
```

Same bootstrap, but `--non-interactive` is passed through to the Node installer, which consumes env vars instead of prompting. Exit codes: 0 ok, 2 missing required env, 3 install failure.

## TUI step flow

```
                         ┌───────────────────────────┐
                         │     Welcome banner        │
                         │  (auto-advance in 800ms)  │
                         └──────────────┬────────────┘
                                        ▼
                         ┌───────────────────────────┐
                         │  Prerequisite check       │
                         │  ✓ Docker daemon          │
                         │  ✓ Docker Compose plugin  │
                         │  ✓ Port 80 free           │
                         │  ✓ Port 443 free          │
                         │  [Continue]               │
                         └──────────────┬────────────┘
                                        ▼
                         ┌───────────────────────────┐
                         │  How should workspaces    │
                         │  be provisioned?          │
                         │                           │
                         │  ▶ Local Docker (default) │
                         │    Bundled Dokploy        │
                         │    Remote Dokploy         │
                         └──────────────┬────────────┘
                                        ▼
                         ┌───────────────────────────┐
                         │  Domain                   │
                         │  (use 'localhost' for     │
                         │   local-only):            │
                         │  > localhost              │
                         └──────────────┬────────────┘
                                        ▼
                  ┌───────── domain != localhost ─────────┐
                  ▼                                       │
       ┌───────────────────────────┐                      │
       │  TLS email for            │                      │
       │  Let's Encrypt:           │                      │
       │  > you@example.com        │                      │
       └──────────────┬────────────┘                      │
                      ▼                                   │
       ┌──────── mode == dokploy-remote ────────┐         │
       ▼                                        │         │
┌───────────────────┐                           │         │
│ Dokploy URL       │                           │         │
│ > https://...     │                           │         │
├───────────────────┤                           │         │
│ API token         │                           │         │
│ > ••••••••        │                           │         │
├───────────────────┤                           │         │
│ Project ID        │                           │         │
├───────────────────┤                           │         │
│ Environment ID    │                           │         │
└────────┬──────────┘                           │         │
         ▼                                      ▼         ▼
                         ┌───────────────────────────┐
                         │  Admin password           │
                         │  (blank = auto-generate): │
                         │  > ••••••••••••••         │
                         └──────────────┬────────────┘
                                        ▼
                         ┌───────────────────────────┐
                         │  Ready to install with:   │
                         │    mode:   docker         │
                         │    domain: localhost      │
                         │                           │
                         │  ▶ Install now            │
                         │    Quit                   │
                         └──────────────┬────────────┘
                                        ▼
                         ┌───────────────────────────┐
                         │  ⠼ Installing…            │
                         │  wrote compose/.env       │
                         │  pulling images…          │
                         │  Image traefik Pulled     │
                         │  Image postgres Pulled    │
                         │  starting services…       │
                         │  [infisical] bootstrap... │
                         │  [infisical] project xyz  │
                         │  restarting server…       │
                         └──────────────┬────────────┘
                                        ▼
                         ┌───────────────────────────┐
                         │  ✔ AgentHub v2 is up.     │
                         │                           │
                         │  URL: http://localhost    │
                         │  Admin user: admin        │
                         │  Admin password: ••••     │
                         │                           │
                         │  Infisical console:       │
                         │    secrets.localhost/     │
                         │    email:    admin@...    │
                         │    password: ••••         │
                         │                           │
                         │  Written to compose/.env  │
                         └───────────────────────────┘
```

## Step → env var mapping

| TUI step | Env var (headless) | Required? |
|---|---|---|
| Provisioner choice | `AGENTHUB_MODE` | yes |
| Domain | `AGENTHUB_DOMAIN` | yes |
| TLS email | `AGENTHUB_TLS_EMAIL` | only if `AGENTHUB_DOMAIN != localhost` |
| Dokploy URL | `AGENTHUB_DOKPLOY_URL` | only if `AGENTHUB_MODE=dokploy-remote` |
| Dokploy API token | `AGENTHUB_DOKPLOY_API_TOKEN` | only if `AGENTHUB_MODE=dokploy-remote` |
| Dokploy Project ID | `AGENTHUB_DOKPLOY_PROJECT_ID` | only if `AGENTHUB_MODE=dokploy-remote` |
| Dokploy Environment ID | `AGENTHUB_DOKPLOY_ENVIRONMENT_ID` | only if `AGENTHUB_MODE=dokploy-remote` |
| Admin password | `AGENTHUB_ADMIN_PASSWORD` | no (random if blank) |

## Under the hood

The "Installing..." step does, in order:

1. Write `compose/.env` with every env var the compose bundle needs (domain, provisioner, Infisical keys, …). Each install generates fresh random values for Infisical's encryption key, DB password, Redis password, auth secret.
2. `docker compose pull --ignore-pull-failures` — pulls Postgres, Redis, Traefik, Infisical from Docker Hub. Locally-built images (server + workspace, if you used `./scripts/install.sh`) are skipped gracefully.
3. `docker compose up -d --pull never` — starts all services. AgentHub boots with `UnconfiguredStore` (Infisical creds are empty at this point).
4. Wait for `http://localhost:8080/api/status` to return 200 (Infisical healthy).
5. `npx -y @infisical/cli bootstrap` — creates an admin user, an organization, and a machine identity inside Infisical. Returns a bearer JWT.
6. Using that JWT: attach universal-auth to the bootstrap identity, generate a client secret, create a "agenthub" project, and verify the identity is a member.
7. Write the resulting `INFISICAL_PROJECT_ID / CLIENT_ID / CLIENT_SECRET` back to `compose/.env`.
8. `docker compose up -d --force-recreate agenthub-server` — restart the server container so it reads the new secret-store config from env.
9. Print both credential sets to stdout.

## Re-running is safe

Running `./scripts/install.sh` or the quick-install one-liner a second time:

- Re-clones / pulls latest from git
- Re-builds images locally (fast, cached)
- Re-runs compose `up -d` (no-op if unchanged)
- **Does NOT re-bootstrap Infisical** if `INFISICAL_CLIENT_ID` is already in `compose/.env`
- Your existing sessions, secrets, and backups survive

If something's wedged, see [troubleshooting.md](../troubleshooting.md).
