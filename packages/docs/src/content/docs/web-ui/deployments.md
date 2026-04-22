---
title: Deployments
description: Apps the agent deployed via the agentdeploy MCP — inventory, status, teardown.
---

**Deployments** is a read-mostly inventory of apps that an agent inside one of your workspaces deployed using the [`agentdeploy` MCP](/docs/agentdeploy/overview/). Each row represents one deployed app.

## Why this page exists

When you tell your agent *"deploy this to my DigitalOcean droplet"*, a lot happens behind the scenes: a droplet is created (or reused), Docker is installed, Traefik is configured, a container is started, DNS is pointed at the IP. The *agent* knows about it; without this page, *you* would have to trust the agent to tell you.

This page is your source of truth: every deployment the MCP touched is recorded server-side, independent of the agent's memory.

## What each row shows

| Column | Meaning |
|---|---|
| Name | The name the agent passed to `deploy_app` or that you gave in the prompt. |
| Provider | `docker` \| `digitalocean` \| `dokploy` — which inner hosting provider was used. |
| Host / URL | Where the app lives (IP or domain). |
| Status | Last reported state from the provider. |
| Created | When the deployment was first made. |
| Updated | Last reported update. |

## What you can do with a row

- **Open** — follows the URL to the deployed app.
- **Destroy** — runs the provider's cleanup. For docker-host: `docker rm -f` on the remote. For DigitalOcean: deletes the droplet. For Dokploy: calls its delete API. Cloudflare DNS records are removed if they were created by the MCP.
- **View details** — shows the full provider config used (secrets redacted), the current status, and recent action log entries.

## What it is *not*

- Not a deploy button. This page shows what's already deployed; agents create new deployments through the MCP.
- Not a live metrics dashboard. Status is pulled on page load — refresh for fresh data.
- Not a billing surface. The providers charge you, not AgentHub.

## Where the data lives

The `deployments` table in AgentHub's SQLite. Deleting a user cascades to their deployment records, but does **not** automatically call **Destroy** on their apps — you need to tear those down first, or the resources will keep billing at the provider. There's an admin task in our backlog to make that automatic.

## Hooking into the MCP

When an agent calls `agentdeploy.deploy_app` inside a workspace, the MCP:

1. POSTs to `/api/agent/deploy` with the session's agent token.
2. Server resolves the inner hosting provider from the user's Integrations.
3. Server runs the provider's `provision` method (docker SSH / DO / Dokploy).
4. Server writes a `deployments` row and returns the URL/IP/status to the agent.

After that, this page shows the row. See [agentdeploy · providers](/docs/agentdeploy/providers/) for tool signatures.
