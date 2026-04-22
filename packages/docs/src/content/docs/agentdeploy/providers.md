---
title: agentdeploy — supported providers
description: The three inner hosting providers — Docker SSH host, DigitalOcean, Dokploy — and how the MCP targets each.
---

The `agentdeploy` MCP supports three inner hosting provider types. *"Inner"* here means: how an agent inside a workspace deploys its apps. The [outer provisioner](/docs/getting-started/install-modes/) — how AgentHub spins up your workspace — is a separate concern.

You configure providers on the [Integrations page](/docs/web-ui/integrations/). Each provider is one row in `infrastructure_configs` plus one secret folder in Infisical.

## `docker` — a remote Docker daemon over SSH

**Integration config:**

- `hostIp` (or hostname)
- `sshUser` (usually `root` or `docker`)
- `sshPrivateKey` (in Infisical)

**How deploys run:**

1. MCP receives `deploy_app({ name, image, port, env, domain? })`.
2. Server SSHes to `sshUser@hostIp` using the private key.
3. Runs `docker pull`, then `docker run -d --name <name> -p <port>:<port> ...` with any env and volume mounts.
4. (Optional) If a `domain` is given and a Cloudflare integration is configured, the server also hits the CF API to add an A record pointing at `hostIp`.

**Best for:**

- Your own VM you already manage (a VPS, an old homelab box).
- Demos where you don't want droplet billing noise.
- Fast iteration — `deploy_app` behaves like local `docker run` with less friction.

**Gotchas:**

- The host needs Docker already installed. No bootstrap.
- Port collisions aren't handled automatically — the agent picks a port and hopes.

## `digitalocean` — managed droplets

**Integration config:**

- `apiToken` (in Infisical)
- `region` (e.g. `nyc3`)
- `sshKeyId` — DigitalOcean SSH key ID (not the content) to authorize on new droplets

**How deploys run:**

1. MCP receives `deploy_app({ name, image, port, env, domain? })`.
2. Server checks if a droplet named `agenthub-<userId>-<name>` exists; if not, creates it (s-1vcpu-1gb in the region, with the ssh key pre-authorized).
3. Waits for SSH-ready, then cloud-inits Docker + Traefik if it's a fresh droplet.
4. `docker run` the app with Traefik labels.
5. (If domain + CF integration) add the A record.

**Best for:**

- Proper deployments behind a real domain with HTTPS.
- When you want the hosting bill to be separate from your own infrastructure.

**Gotchas:**

- Each droplet bills until you **Destroy** the deployment (or delete the droplet directly). The Deployments page has the destroy button.
- First-time cloud-init takes 30–90 seconds. Subsequent deploys on the same droplet are a normal docker pull.

## `dokploy` — a Dokploy instance over API

**Integration config:**

- `baseUrl` (e.g. `https://dokploy.example.com`)
- `apiToken` (in Infisical)
- `projectId` + `environmentId` — where to put apps

**How deploys run:**

1. MCP receives `deploy_app({ name, image, port, env, domain? })`.
2. Server calls Dokploy's REST API to create a service under the chosen project/environment.
3. Dokploy handles the container start, reverse proxy, cert issuance.
4. Server writes the Deployment row; domain config is Dokploy's problem, not AgentHub's.

**Best for:**

- You already run Dokploy in production.
- You want Dokploy's UI for managing what the agent deploys.
- Zero-socket-mount posture — the server never touches Docker directly.

**Gotchas:**

- Destroy uses Dokploy's delete-service API. If Dokploy's gone sideways, the row in AgentHub's DB can't be cleaned up without manual intervention.
- Dokploy's API does change — check upstream [dokploy.com/docs](https://dokploy.com/docs) if something breaks after an upgrade.

## Choosing between them

| You have… | Pick |
|---|---|
| A VPS you SSH into already | `docker` |
| A DigitalOcean account and a domain | `digitalocean` |
| A running Dokploy instance | `dokploy` |
| None of the above | Start with `docker` against `127.0.0.1` (yes, your own host) if you trust your agent on your own box |

## Under the hood

The provider implementations live at [`packages/server/src/services/providers/`](https://github.com/physikal/agenthubv2/blob/main/packages/server/src/services/providers/). Each is a single TS file implementing the `HostingProvider` interface. Adding a new provider means one file + a row in the provider enum.
