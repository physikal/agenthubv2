---
title: Integrations
description: One page for every external service AgentHub talks to — Cloudflare, DigitalOcean, Docker hosts, Dokploy, Backblaze B2, AI provider keys.
---

**Integrations** is a single page that collects every external service AgentHub (and the agents inside its workspaces) can talk to. Each integration has a typed form: you fill it in, secrets go to Infisical, metadata goes to SQLite, and the relevant feature starts working.

## The integration types

### Hosting & infra

| Provider | What it enables | Secret(s) held | Non-secret metadata |
|---|---|---|---|
| **Cloudflare** | DNS automation for `agentdeploy` — agents can point `foo.yourdomain.com` at a deployed droplet without you touching the dashboard. | `apiToken` | `zoneId`, zone name |
| **DigitalOcean** | Inner-layer hosting provider. Agents can provision droplets + Docker + Traefik from inside a workspace. | `apiToken` | `region`, `sshKeyId`, ssh key fingerprint |
| **DigitalOcean App Platform** | Inner-layer hosting provider for DO's managed App Platform — agents deploy apps without managing droplets. | `apiToken` (needs `app:*` scopes) | `region` (optional) |
| **Docker host** | Inner-layer hosting provider targeting an arbitrary Docker daemon over SSH (your own server). | `sshPrivateKey` | `hostIp`, `sshUser` |
| **Dokploy** | Inner-layer hosting provider against a running Dokploy instance. | `apiToken` | `baseUrl`, `projectId`, `environmentId` |
| **Backblaze B2** | Backblaze bucket for `/home/coder` backups. | `keyId`, `appKey` | `bucket`, `subdir` (optional) |

The Cloudflare, DO, DO Apps, Docker, and Dokploy entries are what the [`agentdeploy` MCP](/docs/agentdeploy/overview/) uses when an agent inside a workspace wants to deploy. B2 is used by the [Backups](/docs/web-ui/backups/) page.

### AI providers

| Provider | What it enables | Secret(s) held | Non-secret metadata |
|---|---|---|---|
| **Anthropic API** | Pre-authenticates `claude` in every new session — Claude Code reads `ANTHROPIC_API_KEY` from env, no OAuth flow. | `apiKey` | — |
| **MiniMax** | Powers the `claude-minimax` shim. Routes Claude Code through MiniMax's Anthropic-compatible endpoint. | `apiKey` | `baseUrl` (optional, defaults to `https://api.minimax.io/anthropic`) |
| **OpenAI** | Available as `OPENAI_API_KEY` for any CLI in the workspace that wants it. Not consumed by built-in CLIs today. | `apiKey` | — |

Saving an AI provider row injects the corresponding env var (`ANTHROPIC_API_KEY` / `MINIMAX_API_KEY` + `MINIMAX_BASE_URL` / `OPENAI_API_KEY`) into every **new** session your user creates. Existing sessions don't pick up newly-saved keys — start a new session.

### GitHub App (admin-only)

The Integrations page also hosts the **GitHub App** card at the top — a single install-wide integration admins configure once so every user can grant per-repo access without managing PATs. It's distinct from the per-user rows above: see the [GitHub App docs](/docs/integrations/github-app/) for the full setup.

## How a save works

1. You fill in the form and click **Save**.
2. The server validates the inputs (format checks only — it doesn't talk to the provider yet).
3. Secrets (API tokens, ssh keys, etc.) are pushed to Infisical at `/users/{userId}/<provider>`.
4. Metadata (`zoneId`, `region`, etc.) is written to SQLite's `infrastructure_configs` table.
5. The row shows up on the page with **Verify** and **Delete** buttons.

Click **Verify** to make AgentHub actually call the provider's API — this confirms the credentials work and (for DO/Dokploy) enumerates available regions/projects. Unverified rows still work; they're just untested.

## Editing an integration

Click the row. You can update the non-secret fields inline. To change a secret, delete the row and recreate — we don't support in-place secret rotation in the UI yet. (Behind the scenes Infisical versions the secret, so an audit trail exists.)

## Two hosting-provider layers

Confusingly, AgentHub has *two* provisioners:

- **Outer provisioner** — how AgentHub creates the workspace container for each session. Set at install time by `PROVISIONER_MODE` (docker / dokploy-remote). You don't configure this via the Integrations page.
- **Inner hosting providers** — how an agent inside a workspace deploys *its* apps. Set per-user via the Integrations page (DigitalOcean, Docker host, Dokploy).

The two layers are independent. You can run AgentHub with `PROVISIONER_MODE=docker` (workspaces on the local Docker daemon) and have your agent deploy apps to a DigitalOcean droplet in the same install.

## Security posture

- **No secret ever touches the UI after the initial save.** The forms display obfuscated values (e.g. `sk_****`) when you re-open a saved row. The server never sends the full secret back.
- **All tokens live in Infisical**, not SQLite. If you dump `agenthub.db` you get metadata only.
- **Revoking a token at the provider** (Cloudflare dashboard, DO settings, etc.) revokes its use in AgentHub — no cached copies anywhere.

## Removing

**Delete** on a row:

1. Removes the secret from Infisical
2. Deletes the SQLite row
3. Does **not** undo anything the provider created on your behalf — agents might have left droplets, DNS records, or dokploy services in place. You clean those up out-of-band.
