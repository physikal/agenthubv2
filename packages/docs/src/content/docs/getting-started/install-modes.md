---
title: How the install works
description: Three install modes, one installer, and what "provisioner" means.
---

AgentHub is delivered as a Docker Compose bundle plus an Ink (React-for-terminals) installer. You pick one **provisioner mode** at install time — that choice controls how AgentHub creates workspace containers for each session.

## The three modes

| Mode | What it does | When to pick it |
|---|---|---|
| `docker` | Workspaces run as containers on the local Docker daemon. The server talks to `/var/run/docker.sock` directly. | Default. Self-hosting on one box and you want it to just work. |
| `dokploy-local` | Bundles Dokploy alongside AgentHub. Workspaces are Dokploy services. | You already like Dokploy's UI and want it in the box. |
| `dokploy-remote` | Points AgentHub at a pre-existing Dokploy instance. | You already run Dokploy in production and want AgentHub to reuse it. |

`docker` mode is simplest and is what most users should pick. It does mount `/var/run/docker.sock` into the server container, which is a real security surface. If you need a zero-socket posture, pick a `dokploy-*` mode — Dokploy owns the daemon access and AgentHub talks to it over HTTP.

## The installer

`./scripts/install.sh` (or the one-liner version at the top of the [repo README](https://github.com/physikal/agenthubv2#install)) runs these steps:

1. **pnpm install** the installer package only (it's small and self-contained).
2. **docker build** both images locally (`agenthubv2-server:local` + `agenthubv2-workspace:local`) unless you pin published tags via `AGENTHUB_SERVER_IMAGE` / `AGENTHUB_WORKSPACE_IMAGE`.
3. **Install the `agenthub` operator CLI** to `/usr/local/bin/agenthub`.
4. **Run the TUI** — or if you pass `--non-interactive` + env vars, skip straight to install.

The TUI asks you (with defaults) for:

- Provisioner mode (the three above)
- Domain (`localhost` or your hostname)
- TLS email (required for non-localhost domains — used by Let's Encrypt)
- Admin password (leave blank to auto-generate)

Then it:

- Writes `compose/.env` with every secret pre-generated (Infisical encryption key, DB passwords, admin password, etc.)
- `docker compose pull` + `docker compose up -d`
- **Bootstraps Infisical** (polls its API, creates admin org + machine identity, writes credentials back to `.env`)
- `docker compose up -d --force-recreate agenthub-server` to pick up the Infisical creds
- Prints two sets of admin credentials (AgentHub + Infisical) and the login URL

The Infisical bootstrap step is the one most likely to take a while — first boot of the Infisical Postgres needs 30–60 seconds for migrations.

## Where full install docs live

This is the in-app summary. The authoritative install documents are in the repo:

- **Humans:** [`docs/install/humans.md`](https://github.com/physikal/agenthubv2/blob/main/docs/install/humans.md) — the step-by-step with screenshots.
- **Agents:** [`docs/install/agents.md`](https://github.com/physikal/agenthubv2/blob/main/docs/install/agents.md) — env-var-driven headless install for other agents driving AgentHub's installer.
- **Installer internals:** [`docs/install/installer-flow.md`](https://github.com/physikal/agenthubv2/blob/main/docs/install/installer-flow.md) — which step maps to which env var and what happens under the hood.

## Reinstalling / upgrading

Running the install script again is safe. It picks up from wherever it left off — if Infisical is already bootstrapped, it detects that and skips. If you change your mind about a mode, edit `compose/.env` directly and `docker compose up -d --force-recreate`.

To upgrade, use the Web UI **Settings → Version → Update now** button, or run `agenthub update` on the host. Both share the same code path. See [Updates](/docs/operators/updates/).

To wipe and start over — including deleting every user's home directory — see the [troubleshooting "wipe everything"](/docs/operators/troubleshooting/#how-do-i-wipe-everything-and-start-over) entry.
