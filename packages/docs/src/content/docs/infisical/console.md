---
title: Using the Infisical console
description: How to open the bundled Infisical admin UI, log in, and find your secrets.
---

## Opening the console

The bundled Infisical admin console lives on its own `:8443` entrypoint. **The scheme depends on your [access mode](/docs/operators/access-modes/):**

- **lan mode (default):** plain HTTP — `http://<your-host>:8443/`. There is no TLS in lan mode, so `https://` will **fail to connect**. This trips people up: browsers love to upgrade you to `https://`, and it won't work. Type `http://` explicitly.
- **public mode:** `https://<your-host>:8443/`, using Traefik's default self-signed cert.

For local installs that's `http://localhost:8443/` (lan) or `https://localhost:8443/` (public). Your Traefik routes the `:8443` entrypoint to the Infisical container either way.

The **Secrets** page in AgentHub has a button that opens the right URL for your mode in a new tab — that's the intended path, and it always picks the correct scheme.

## Accepting the cert (public mode only)

In lan mode there's no cert — nothing to accept.

In public mode the `:8443` entrypoint uses Traefik's default **self-signed** cert (not your Let's Encrypt one, which is bound to `:443`). Your browser shows a big red warning the first time — click **Advanced → Proceed (unsafe)**.

If you hit the URL from a script in public mode, the TLS handshake fails because your system trust store doesn't include the self-signed root. Pass `-k` to curl for testing.

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
