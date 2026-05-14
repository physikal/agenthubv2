---
title: Deployment topology
---


Where should AgentHub live? The defaults assume a single Linux VM with
Docker, but several other shapes work too. Pick what fits your network
and security posture.

## 1. Single VM (default)

```
┌─ Your host (Debian/Ubuntu) ──────────────────────────────────────────┐
│  :80   → Traefik → AgentHub server                                   │
│  :8443 → Infisical admin console                                     │
│  Docker daemon owns the workspace containers                         │
└──────────────────────────────────────────────────────────────────────┘
```

What `curl|bash` gives you. Best for: home labs, side projects, single
operator. AgentHub binds host ports directly; access is HTTP-on-LAN by
default.

**Tradeoff**: The server container mounts `/var/run/docker.sock` so it
can spawn workspace containers. That gives root-equivalent access to
the host's Docker daemon. Mitigations: use rootless Docker (#3 below)
or `dokploy-remote` mode (#4 below).

## 2. Single VM + public HTTPS

Same as #1 but switch access mode to `public` during install (or run
`agenthub reconfigure-access` afterward). Let's Encrypt handles the
cert via TLS-ALPN-01 (needs `:443` reachable from the internet) or
DNS-01 (needs a DNS provider API token).

```
Internet → :443 (Let's Encrypt cert) → Traefik → AgentHub server
            :80  HTTP→HTTPS redirect
```

See [`access-modes.md`](access-modes.md) for the public-mode setup.

## 3. Single VM, rootless Docker

For zero host-root exposure: run the Docker daemon as a non-root user
and point AgentHub at it over TCP instead of mounting the socket.

```bash
# On the host, after rootless-docker is installed for the AGENTHUB_OWNER user:
# In compose/.env:
DOCKER_HOST=tcp://rootless-docker.agenthub:2375
AGENTHUB_ALLOW_SOCKET_MOUNT=false
```

The `agenthub-server` container won't bind-mount `/var/run/docker.sock`;
instead it talks to your rootless daemon over the docker network. The
operator-side `agenthub update` flow still needs root to `docker pull`
images, but the runtime path is unprivileged.

This is a supported configuration but the installer doesn't auto-detect
rootless Docker — set the env vars manually.

## 4. AgentHub + remote Dokploy

Skip running Docker on the AgentHub host entirely. Let Dokploy own the
container runtime; AgentHub talks to it over the HTTP API.

```
┌─ AgentHub host ──────┐         ┌─ Dokploy host ─────────────────────┐
│  :80 → AgentHub server│ HTTPS  │  Dokploy API on :3000              │
│                       │───────▶│  Dokploy-managed Docker daemon     │
│  No Docker daemon!    │ (API)  │  Workspace containers run here     │
└───────────────────────┘         └────────────────────────────────────┘
```

Install with `AGENTHUB_MODE=dokploy-remote` and provide the four
`AGENTHUB_DOKPLOY_*` env vars. Zero socket mount. Useful when AgentHub
runs on a small VM and the heavy lifting happens on a different box.

## 5. AgentHub behind your own reverse proxy

The bundled Traefik is the recommended setup, but you can put another
reverse proxy in front (Nginx, Caddy, your existing Traefik). Two
common patterns:

### a. External proxy terminates TLS; AgentHub stays plain-HTTP

Install with `AGENTHUB_ACCESS_MODE=lan` (HTTP on :80). Your external
proxy listens on :443, terminates TLS, and proxies to the AgentHub
host's :80. From AgentHub's perspective nothing changes — the bundled
Traefik just routes plain HTTP internally.

Make sure to set `AGENTHUB_PUBLIC_URL=https://your-domain` in
`compose/.env` so cookies get the `Secure` flag and CORS recognizes
the external origin.

### b. Avoid the bundled Traefik entirely

Possible but not officially supported. The AgentHub server listens on
`:3000` inside the `agenthub-server` container. Removing the
`traefik` service from compose and pointing your own reverse proxy at
`agenthub-server:3000` should work, but:

- You take over `:8443` for the Infisical console too.
- `agenthub reconfigure-access` won't run cleanly — that's
  Traefik-aware. Don't use it.
- The `tls.resolver` field in `/api/health` will say `lan` regardless
  of what your external proxy is doing.

File issues if you go this route; we're not actively testing it.

## 6. AgentHub on Kubernetes

Not yet officially supported. The compose bundle isn't packaged as a
Helm chart. You could manually transpose the compose services to
Deployments + Services + a PersistentVolumeClaim per `agenthub-data`,
`infisical-pg-data`, `infisical-redis-data`, and `traefik-letsencrypt`
— but the per-user workspace volumes (`agenthub-home-{userId}`) are
created on the fly by AgentHub via the local Docker daemon, which
doesn't translate to Kubernetes' volume model directly.

If you need this shape, `AGENTHUB_MODE=dokploy-remote` with Dokploy in
the Kubernetes cluster is the closest supported path.

## 7. WSL2 / macOS Docker Desktop

Neither is currently supported.

WSL2 with Docker Desktop's WSL backend *probably* works for the install
script (it's just Debian/Ubuntu under the hood), but the bundled
Traefik's host-port binding interacts with Docker Desktop's port
forwarding in ways the installer doesn't test. macOS has the same
Docker Desktop quirks plus filesystem-mount-semantics differences for
the `agenthub-home-{userId}` volumes.

If you want to try anyway: install Docker Desktop + Node 22 + pnpm
manually, clone the repo, run `./scripts/install.sh` (not the
`curl|bash` one-liner, which will reject macOS). File issues for what
breaks.

## Picking your shape

- **"I just want it running on my home server."** → #1 (default).
- **"I want my team to reach it on a real domain."** → #2.
- **"I'm security-conscious and don't want to mount docker.sock."** →
  #3 (rootless) or #4 (Dokploy).
- **"I already run Caddy / Nginx in front of everything."** → #5a
  (external proxy, AgentHub stays plain).
- **"My infra is Kubernetes-native."** → not yet — talk to us.
