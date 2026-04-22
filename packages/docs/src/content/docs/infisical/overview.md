---
title: Why Infisical is bundled
description: What Infisical is, why it's in the box, and how AgentHub uses it.
---

[Infisical](https://infisical.com) is an open-source secret-management platform. AgentHub bundles it in the Docker Compose stack and uses it as the single store for every piece of sensitive provider credential.

## What lives in Infisical

Every external-service credential that AgentHub accepts from you or from an agent lands in Infisical at the path `/users/{userId}/...`:

- `cloudflare` — Cloudflare API token
- `digitalocean` — DigitalOcean API token
- `docker` — remote Docker host ssh private key
- `dokploy` — Dokploy API token
- `b2` — Backblaze B2 keyId + appKey

These are written by the [Integrations page](/docs/web-ui/integrations/) when you save a row. They are read by the server when an operation needs them (a deploy, a backup, a DNS change). **They never touch SQLite.**

## What *doesn't* live in Infisical

For contrast, these live in SQLite:

- User accounts + password hashes
- Session records (workspace id, host, ip, state)
- Infrastructure config metadata (zoneId, region, host IP — the non-secret half of each integration)
- Deployment inventory
- Backup run history
- Package catalog state

The rule of thumb: if it's a token or key, Infisical. If it's a pointer or descriptor, SQLite.

## Why this split?

Three reasons:

1. **Audit log.** Infisical records every read and write of every secret, tamper-evident. SQLite would need us to bolt that on.
2. **Rotation.** Infisical versions secrets natively — updating a secret keeps the old version available for a rollback window. SQLite would need columns + cleanup jobs.
3. **Blast radius.** If `agenthub.db` leaks, you get metadata. If Infisical leaks, you have bigger problems but at least one thing to compromise rather than two.

## How the server reaches Infisical

The server container is configured with:

- `INFISICAL_URL=http://infisical:8080` (internal compose network)
- `INFISICAL_PROJECT_ID`, `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET` — universal-auth creds for a machine identity created at install time
- `INFISICAL_ENVIRONMENT=prod` (default)

It talks to Infisical over the `@infisical/sdk` npm client. On boot the `SecretStore` initializes; if the credentials are missing it falls back to an `UnconfiguredStore` that refuses writes and logs a clear `Secret store not configured` error on reads.

## How you reach Infisical

Through the [Secrets page](/docs/web-ui/secrets/), which opens the admin console at `https://<your-host>:8443/`. See [Using the console](/docs/infisical/console/) for the guided tour.

## What happens on install

The installer drives Infisical's bootstrap flow:

1. Polls `http://localhost:8080/api/status` until it's up (Postgres migration can take 30–60s on first boot).
2. Runs `npx @infisical/cli bootstrap` to create the admin user, org, and an instance-admin machine identity.
3. Attaches universal-auth to that identity, generates a client secret.
4. Creates a default project.
5. Writes `INFISICAL_PROJECT_ID / CLIENT_ID / CLIENT_SECRET / ADMIN_EMAIL / ADMIN_PASSWORD` back to `compose/.env`.
6. Force-recreates the server so it picks up the new creds.

All idempotent — re-running the installer if something fails halfway resumes from the right step.

## What this costs

Infisical itself has no licensing cost for the self-hosted community edition you get here. Running cost: one small Postgres (Infisical's own database, ~50 MB idle) + one Redis (cache, ~5 MB idle) + the Infisical API container (~150 MB idle). Total overhead is ~250 MB RAM and ~500 MB disk.

You **can** swap in an external Infisical instance by pointing `INFISICAL_URL` at it and providing the right credentials in `.env`, but nobody's tested that recently — expect a little yak-shaving.
