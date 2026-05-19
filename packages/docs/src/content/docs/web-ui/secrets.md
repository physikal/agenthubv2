---
title: Secrets
description: Your jump-off point to the bundled Infisical admin console.
---

**Secrets** is a short page that does one thing: hand you off to the Infisical admin console at `https://<your-host>:8443/`. Every provider credential AgentHub handles (Cloudflare tokens, DigitalOcean tokens, Docker host ssh keys, Dokploy API tokens, Backblaze B2 keys) lives in Infisical. The Secrets page is the portal to that console when you want to browse folders, environments, audit logs, or manage secret versions directly.

## What's on the page

- A **"Open Infisical console"** link that opens `http://<your-host>:8443/` (lan mode) or `https://<your-host>:8443/` (public mode) in a new tab. See [Access modes](/docs/operators/access-modes/) for which scheme your install uses.
- **Workspace secrets** — per-user env vars that AgentHub injects into your workspace shell on session start. See [Workspace secrets](#workspace-secrets) below.
- (Admin only) **"Reveal Infisical admin login"** — requires you re-enter your AgentHub password, then shows the Infisical admin password.

## Workspace secrets

This is the supported path for getting a secret (API token, key, etc.) from your AgentHub install into the agent shell so Claude / Codex / OpenCode / your own code inside the session can read it as an env var.

### When to use this

You want **Claude in your session** to call a third-party API. Example: you want the agent to manage your Cloudflare DNS, so you need it to be able to run:

```bash
curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/zones
```

For that to work, the env var `CLOUDFLARE_API_TOKEN` must be set in the workspace shell. Workspace secrets is how you set it.

### How it works

Each row you add is stored as a secret in Infisical at `/users/{yourUserId}/workspace-env/{NAME}`. When you start a new session, the server reads everything under that path and exports each as an env var inside the workspace container. The agent (and any process you run) sees them with `env`, `echo $NAME`, `printenv`, etc.

### Adding a secret

1. Open Secrets → **Add workspace secret**.
2. Name: must be POSIX env-var style — uppercase letters, digits, underscores, can't start with a digit. Lowercase and dashes are rejected client-side and server-side.
3. Value: the actual secret. Paste a token, a key, a multi-line file contents — anything up to 32 KB.
4. Save. The value is **write-only** after this — the list endpoint returns names only. To rotate, delete the row and add a new one with the same name.

### What's reserved

These env-var names are set by AgentHub itself and can't be used:

- `AGENT_TOKEN`, `PORT`, `HOME`, `PATH`, `USER`, `SHELL` — system or session-bootstrap vars
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MINIMAX_API_KEY`, `MINIMAX_BASE_URL` — set from your [Integrations](/docs/web-ui/integrations/) AI-provider rows
- `GITHUB_ACCOUNT_LOGIN` — set when a GitHub App installation is active

Trying to save any of these returns a 400. (We also filter them out at injection time as a belt-and-suspenders check, so a workspace secret that somehow landed in Infisical with one of these names would still be ignored.)

### Sessions only see what existed at start

Workspace secrets are read once, at session-active time. If you **add or change a secret while a session is already running**, that session keeps the old env. Either restart the session, or `export` the new value manually in the terminal.

### SSH keys

For multi-line secrets like SSH private keys, paste the whole file (`-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----\n`) as the value. Inside the session, write it back to disk:

```bash
echo "$MY_SSH_KEY" > ~/.ssh/id_ed25519
chmod 600 ~/.ssh/id_ed25519
```

(A `~/.bashrc` snippet can automate this if you want it on every session, but be mindful that any script you run inside the workspace can read all env vars — there's no per-process isolation.)

### Workspace secrets vs Integrations

Two different things, easy to confuse:

| | Workspace secrets | Integrations |
|---|---|---|
| Where the secret is used | Inside your workspace, by you / the agent | By the AgentHub server itself (deploy, DNS, backup automation) |
| Format | Free-form name + value | Structured per-provider form (Cloudflare, B2, etc.) |
| Provider knowledge | None — AgentHub just sets `NAME=VALUE` | AgentHub knows how to call the provider's API |
| Verify button | No | Yes |
| Reaches the workspace shell | Yes (env var) | No |

## Why :8443 and not a subdomain?

The compose bundle exposes the Infisical console on its own Traefik entrypoint (`:8443`). This means `localhost` installs can reach it at `https://localhost:8443/` without needing a `/etc/hosts` entry for `secrets.localhost`. It's the same Traefik, the same TLS certificate stack, just a different port.

The first visit shows a self-signed-cert warning — click through. Traefik will use the same Let's Encrypt cert on `:8443` as on `:443` if you're on a real domain.

## The "Reveal" flow

Infisical (as of writing) has self-registration disabled by default and no working SMTP reset flow. That means if an admin loses the Infisical password that was printed once at install time, normally they'd be locked out.

The Reveal flow fixes this: the installer persists the Infisical admin password into `compose/.env` as `INFISICAL_ADMIN_PASSWORD`, and the server exposes an admin-gated endpoint that reads it back. To use it:

1. **You are an AgentHub admin.**
2. Open Secrets → **Reveal Infisical admin login**.
3. Re-enter your AgentHub password (fresh auth step — the cookie isn't enough).
4. The page shows the Infisical admin email + password for 30 seconds.

That's the only path. No other user, role, or endpoint exposes the Infisical credentials.

## The "Failed to login without SRP" browser message

When you log into the Infisical console, your browser console may print:

```
Failed to login without SRP, attempting to authenticate with legacy SRP authentication
```

**This is benign.** Infisical tries a newer auth path first, falls back to legacy SRP, and the login succeeds either way. You can ignore it. We haven't filed a bug upstream because the message is informational, not an error.

## Adding secrets manually

You *can* create secrets directly in the Infisical console, under `/users/{yourUserId}/...`. Don't, in most cases:

- For provider credentials AgentHub already knows about (Cloudflare, DO, Docker host, Dokploy, B2, GitHub, AI providers), use the [Integrations page](/docs/web-ui/integrations/) — it enforces the naming conventions the server expects, writes the matching `infrastructure_configs` row, and gives you a **Verify** button.
- For env vars you want injected into your workspace shell, use [Workspace secrets](#workspace-secrets) above — it's the same Infisical storage but with the right path layout and an injection hookup at session start.

Hand-editing Infisical behind AgentHub's back is supported (it'll pick up the new values on the next read) but error-prone — typos in paths break everything silently. The audit log will still record your edits, which is the one upside.

## Audit log

Infisical's console has a full audit log (read/write events, who, when, from which machine identity). It's the only tamper-evident record of secret access in AgentHub. Worth checking occasionally if you have multiple users.

## Rotating Infisical credentials

See the [Troubleshooting / rotate creds](/docs/operators/troubleshooting/#how-do-i-rotate-infisical-creds) section. Summary: create a new machine identity in the console, update `compose/.env`, `docker compose up -d --force-recreate agenthub-server`.
