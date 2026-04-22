---
title: Secrets
description: Your jump-off point to the bundled Infisical admin console.
---

**Secrets** is a short page that does one thing: hand you off to the Infisical admin console at `https://<your-host>:8443/`. Every provider credential AgentHub handles (Cloudflare tokens, DigitalOcean tokens, Docker host ssh keys, Dokploy API tokens, Backblaze B2 keys) lives in Infisical. The Secrets page is the portal to that console when you want to browse folders, environments, audit logs, or manage secret versions directly.

## What's on the page

- A **"Open Infisical console"** link that opens `https://<your-host>:8443/` in a new tab.
- Your current Infisical admin email, copyable.
- (Admin only) **"Reveal Infisical admin login"** — requires you re-enter your AgentHub password, then shows the Infisical admin password.

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

You *can* create secrets directly in the Infisical console, under `/users/{yourUserId}/...`. Don't. The AgentHub [Integrations page](/docs/web-ui/integrations/) is the preferred path:

- It enforces the naming conventions the server expects (`/users/{userId}/cloudflare`, etc.).
- It writes the matching metadata row in `infrastructure_configs`.
- It lets you click **Verify** to test the credential.

Hand-editing Infisical behind AgentHub's back is supported (it'll pick up the new values on the next read) but error-prone — typos in paths break everything silently.

## Audit log

Infisical's console has a full audit log (read/write events, who, when, from which machine identity). It's the only tamper-evident record of secret access in AgentHub. Worth checking occasionally if you have multiple users.

## Rotating Infisical credentials

See the [Troubleshooting / rotate creds](/docs/operators/troubleshooting/#how-do-i-rotate-infisical-creds) section. Summary: create a new machine identity in the console, update `compose/.env`, `docker compose up -d --force-recreate agenthub-server`.
