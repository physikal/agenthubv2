---
title: Using the Infisical console
description: How to open the bundled Infisical admin UI, log in, and find your secrets.
---

## Opening the console

The bundled Infisical admin console lives at:

```
https://<your-host>:8443/
```

For local installs: `https://localhost:8443/`. For real-domain installs: `https://your-domain.example.com:8443/`. Your Traefik routes the `:8443` entrypoint to the Infisical container.

The **Secrets** page in AgentHub has a button that opens this URL in a new tab, which is the intended path.

## Accepting the cert

Localhost installs use Traefik's default self-signed cert. Your browser shows a big red warning the first time — click **Advanced → Proceed to `localhost` (unsafe)**. On real-domain installs Traefik uses your Let's Encrypt cert; no warning.

If you forget this step and hit the URL from a script, the TLS handshake will fail because your system trust store doesn't include the self-signed root. Pass `-k` to curl for testing.

## The "Failed to login without SRP" browser message

Once past the cert warning, open your browser devtools and try to log in. You may see this console message:

```
Failed to login without SRP, attempting to authenticate with legacy SRP authentication
```

**Benign.** Infisical tries its new auth path first, falls back to the legacy SRP flow, and the login succeeds. The second attempt is the one that works. You can ignore the first line; your login *did* work.

## Logging in

Credentials from install:

- **Email:** `admin@agenthub.local` (unless overridden in `.env`)
- **Password:** the auto-generated password from install

If you've lost the password, use the [Secrets page Reveal flow](/docs/web-ui/secrets/#the-reveal-flow). It's the only supported recovery path.

## What you see after login

Infisical's UI organizes secrets into:

- **Organization** — one, created at install time, named "AgentHub".
- **Project** — one, also created at install. This is where the `@infisical/sdk` calls land.
- **Environments** — the project has the default three (dev, staging, prod). AgentHub writes to `prod` by default (override with `INFISICAL_ENVIRONMENT` in `.env`).
- **Folders** — AgentHub organizes secrets as `/users/{userId}/<provider>`. Each user has their own folder; each folder has one secret per provider.

To see your own secrets, navigate: **Organization** (AgentHub) → **Project** → **prod** environment → **/users/** → pick your userId folder.

## When to use the console directly

For most operations, the [Integrations page](/docs/web-ui/integrations/) is the right UI. Use the Infisical console when:

- **You want to rotate a secret** outside of delete-and-recreate — Infisical versions changes, so you can roll back.
- **You want to inspect the audit log** — who read or wrote a secret, from which machine identity, and when.
- **You want to add a user** to Infisical directly — e.g., to give someone read-only access to a subset of secrets via Infisical's own RBAC.
- **Something's broken** and you need to confirm the server actually wrote the value it thinks it did.

## When *not* to use it

- **Do not manually create secrets** at paths AgentHub uses (`/users/{userId}/<provider>`). AgentHub expects a matching row in SQLite's `infrastructure_configs`, which you can't set from Infisical. Use the Integrations page for these.
- **Do not delete Infisical's machine identities** (the ones named `agenthub-server-*`). The server uses them to authenticate; removing them breaks every secret read.
- **Do not change the Infisical project or environment** the server is configured to use. That's set in `compose/.env` (`INFISICAL_PROJECT_ID`, `INFISICAL_ENVIRONMENT`) — touch it only if you know exactly what you're doing.

## Logging out

Top-right avatar → **Logout**. Your `/users/{userId}` folder and all secrets stay; you're just signing out of the Infisical console. AgentHub's server continues to use its own machine-identity auth.

## Full Infisical docs

The bundled Infisical is a stock build — everything at https://infisical.com/docs applies. This page only covers the AgentHub-specific access path.
