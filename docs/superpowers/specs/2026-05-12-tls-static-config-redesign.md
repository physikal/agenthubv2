# TLS static-config redesign

**Date:** 2026-05-12
**Status:** Approved for execution
**Supersedes:** the override-merge approach in `2026-05-05-flexible-tls-install-design.md` (specifically the `command:`/`environment:` merge strategy in `render-override.ts`)
**Reference:** [issue #64](https://github.com/physikal/agenthubv2/issues/64), bugs 1, 9, 10, 11

## Problem (recap)

PR #62 generated `compose/traefik.override.yml` with mode-specific Traefik config injected via either `services.traefik.command:` (original) or `services.traefik.environment:` (PR #69 attempt). End-to-end testing on Proxmox VM 920 (cold one-liner install with `AGENTHUB_TLS_MODE=self-ca`) surfaced four blocking issues:

1. **`command:` is replaced by docker-compose merge** (bug #1) — base Traefik's `--providers.docker`, entrypoints, and redirect flags get clobbered when the override defines its own `command:` array. PR #69 worked around this by switching to env vars.
2. **Env-var workaround doesn't actually activate the file provider** (bug #11) — Traefik's static-config precedence is `file > CLI > env vars`. CLI flags in the base compose's `command:` win over the override's env vars. Setting `TRAEFIK_PROVIDERS_FILE_DIRECTORY` alone doesn't enable the file provider when CLI flags are also present. Verified by experiment: a one-shot `docker run traefik --providers.file.directory=…` (CLI flag) loaded the file provider; the same volume + env var on VM 920's Traefik didn't.
3. **Installer's `runCompose` ignores its own `COMPOSE_FILE`** (bug #9) — the installer writes `COMPOSE_FILE=docker-compose.yml:traefik.override.yml` to `.env`, but its own `runCompose` invocation passes `-f docker-compose.yml` only. So the override's services (`traefik-self-ca-init`, `-renew`, `agenthub-static`) never get instantiated by the install. Even if env vars worked, the install wouldn't bring them up.
4. **Global :80→:443 redirect blocks `/install/ca`** (bug #10) — base compose's `--entrypoints.web.http.redirections.entrypoint.to=websecure` is entrypoint-level, not router-level. The static container's `/install/ca` and `/.well-known/agenthub-ca.crt` routers can't bypass it.

The cumulative result: self-CA mode never worked end-to-end on a real install. Unit tests (snapshot of YAML shape) couldn't catch the runtime breakage.

## Goal

Make TLS mode-specific Traefik configuration actually take effect on a real Debian 12 install, end-to-end, for all four modes (`auto`, `public-alpn`, `dns-01`, `self-ca`). No surprise compose-merge interactions. No silent no-ops.

## Non-goals

- Changing the user-facing TLS surface (modes, env-var contract, CLI commands, web UI). User-facing surface stays identical.
- Re-introducing the spec's "Bring your own cert" follow-up (still out of scope).
- Multi-domain installs.

## Approach

**Single source of truth for Traefik static config: a `traefik.yml` file generated at install time, mounted via base compose, loaded via `--configfile`.**

```
┌─────────────────────────────────────────────────────────────┐
│ Installer (TypeScript)                                       │
│   render-traefik-config.ts (NEW) — generates traefik.yml    │
│   based on resolved mode + DOMAIN + TLS_EMAIL + LAN_IP       │
└────────────────────────────┬────────────────────────────────┘
                             │ writes
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ compose/traefik.yml (NEW; gitignored; per-install)          │
│   - entrypoints (always)                                     │
│   - providers.docker (always)                                │
│   - providers.file (self-ca only) → /etc/traefik/dynamic    │
│   - cert resolver `le` (public-alpn or dns-01 only)         │
│   - http→https redirect (always, but as router middleware    │
│     so static-content routers can opt out)                   │
└────────────────────────────┬────────────────────────────────┘
                             │ mounted at /etc/traefik/traefik.yml
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ Traefik (base compose)                                       │
│   command: ["--configfile=/etc/traefik/traefik.yml"]         │
└─────────────────────────────────────────────────────────────┘
```

### What disappears

- `compose/traefik.override.yml` mode-specific Traefik config (env vars / commands). Replaced by the static `traefik.yml`.
- `packages/installer/src/lib/tls/render-override.ts` Traefik service block (the env-var or command-array generation).
- `--providers.docker=true` etc. as CLI flags in `compose/docker-compose.yml`'s traefik command.

### What stays

- The override file pattern itself, but limited to **auxiliary services** that self-CA mode adds (the init container, renew sidecar, nginx static container). These are dict-typed services, not list-typed config — they merge cleanly.
- Mode resolution logic (`resolve-mode.ts`).
- Cert probe (`probe-cert.ts`, `services/tls/health.ts`).
- All user-facing env vars (`AGENTHUB_TLS_MODE`, etc.).
- TUI flow.
- Web UI Reconfigure modal.
- `agenthub reconfigure-tls`.

### Change to base compose

`compose/docker-compose.yml`:

```yaml
services:
  traefik:
    image: traefik:v3.6
    restart: unless-stopped
    command:
      - --configfile=/etc/traefik/traefik.yml
    ports:
      - "80:80"
      - "443:443"
      - "8443:8443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - traefik-letsencrypt:/letsencrypt
      - ./traefik.yml:/etc/traefik/traefik.yml:ro
      # Optional, only mounted when self-ca mode adds it via override:
      # - traefik-self-ca:/etc/traefik/dynamic:ro
```

`./traefik.yml` is per-install (gitignored). It's generated by the installer and rewritten by `agenthub reconfigure-tls`.

### `traefik.yml` shape (rendered)

For all modes:
```yaml
log:
  level: INFO
entryPoints:
  web:
    address: :80
  websecure:
    address: :443
  infisical:
    address: :8443
providers:
  docker:
    exposedByDefault: false
api:
  dashboard: false
http:
  middlewares:
    redirect-to-https:
      redirectScheme:
        scheme: https
```

Plus mode-specific additions (composed onto the base shape):

**`public-alpn`:**
```yaml
certificatesResolvers:
  le:
    acme:
      tlsChallenge: {}
      email: ${TLS_EMAIL}
      storage: /letsencrypt/acme.json
```

**`dns-01`:**
```yaml
certificatesResolvers:
  le:
    acme:
      dnsChallenge:
        provider: ${dnsProvider}
      email: ${TLS_EMAIL}
      storage: /letsencrypt/acme.json
```
(Provider creds via container env vars — env-var merge for that container is fine because `environment:` IS a dict-merge.)

**`self-ca`:**
```yaml
providers:
  docker:
    exposedByDefault: false
  file:
    directory: /etc/traefik/dynamic
    watch: true
```

Plus the override file gains the volume mount + the static-content services as before.

### `/install/ca` redirect bypass (bug #10 fix)

Convert the http→https redirect from entrypoint-level to per-router middleware:

```yaml
# In traefik.yml (always):
http:
  middlewares:
    redirect-to-https:
      redirectScheme:
        scheme: https
        permanent: true
```

Each docker-labeled router opts in via the middleware label:
```yaml
- traefik.http.routers.<name>.middlewares=redirect-to-https@file
```

The agenthub-static container (self-ca only) **omits** the middleware on its `/install/ca` and `/.well-known/agenthub-ca.crt` routers, so they serve directly on :80 without redirect.

The base compose adds the middleware label to a generic catch-all router that intercepts everything else on :80 (so we don't accidentally open an HTTP surface for the agenthub app).

### Migration story

Existing installs (whether on the broken `command:` shape or the broken `environment:` shape) auto-migrate on first boot of the new agenthub-server:

1. Boot detects `compose/traefik.yml` is missing (or old shape).
2. Reads existing `.env`'s `DOMAIN` / `TLS_EMAIL` / `AGENTHUB_TLS_MODE` / `AGENTHUB_LAN_IP`.
3. Renders the new `traefik.yml` via the installer's render module.
4. Removes the now-stale `compose/traefik.override.yml` Traefik service block (leaves the self-CA auxiliary services intact).
5. Restarts Traefik.

Lives in `packages/installer/src/lib/tls/migrate.ts` (extends the existing migrate flow).

## File layout summary

| Path | Status | Purpose |
|---|---|---|
| `compose/docker-compose.yml` | modified | traefik service uses `--configfile=`; mounts `traefik.yml`. |
| `compose/traefik.yml` | new (generated, gitignored) | Per-install static Traefik config. |
| `compose/traefik.override.yml` | modified | Trimmed: only carries self-ca auxiliary services + volume mount. No more `services.traefik.command:` or `environment:`. |
| `compose/.gitignore` | modified | Add `traefik.yml`. |
| `packages/installer/src/lib/tls/render-traefik-config.ts` | new | Generates `traefik.yml` based on mode. |
| `packages/installer/src/lib/tls/render-override.ts` | modified | Loses Traefik service config; keeps self-ca auxiliary service definitions. |
| `packages/installer/src/lib/tls/render-override.test.ts` | modified | Update assertions. |
| `packages/installer/src/lib/tls/render-traefik-config.test.ts` | new | Snapshot tests for each mode. |
| `packages/installer/src/lib/tls/migrate.ts` | modified | Migrate existing installs to new shape. |
| `packages/installer/src/lib/compose.ts` | modified (bug #9 fix) | `runCompose` reads `COMPOSE_FILE` from `.env` if present, otherwise defaults to `-f docker-compose.yml`. |
| `packages/installer/src/run.ts` | modified | Calls `renderTraefikConfig` before `composePull` / `composeUp`. |
| `packages/installer/src/headless.ts` | modified | Same. |
| `packages/installer/src/reconfigure.ts` | modified | Renders new `traefik.yml` instead of writing only override file. |

## Testing strategy

### Unit tests

- `render-traefik-config.test.ts` — snapshot of generated YAML for each mode.
- `render-override.test.ts` — assert override no longer contains `services.traefik.command` OR `services.traefik.environment`.
- `migrate.test.ts` — auto-migration from old shape (env-var override OR command-array override) to new shape (static config + trimmed override).

### Integration

- `e2e-full.js` extends with: cold install with `AGENTHUB_TLS_MODE=self-ca` against a fresh Debian 12, verify cert is `AgentHub Self-CA`, `/install/ca` returns 200 on :80 (no redirect), `/.well-known/agenthub-ca.crt` returns the CA cert.

### Manual verification (the test that PR #62's design failed)

1. Clone Proxmox template → fresh Debian 12 VM.
2. Run documented one-liner with `AGENTHUB_TLS_MODE=self-ca AGENTHUB_DOMAIN=<host> AGENTHUB_LAN_IP=<vm-ip>`.
3. Verify:
   - `docker exec agenthub-traefik-1 ps aux` → `traefik --configfile=/etc/traefik/traefik.yml`
   - `openssl s_client -connect <vm-ip>:443 -servername <host> | openssl x509 -noout -issuer` → `AgentHub Self-CA (<host>)`
   - `curl -sv http://<host>/install/ca/` → 200, HTML page (no redirect)
   - `curl -s http://<host>/.well-known/agenthub-ca.crt` → 200, PEM cert
   - `/api/health.tls.resolver === 'self-ca'`

## Migration / rollout

1. Land this PR. Existing installs auto-migrate on next `agenthub update` (boot-time migrate).
2. localhost installs unaffected (no `traefik.yml` generated).
3. public-alpn installs continue working (new `traefik.yml` matches the working flag set).
4. dns-01 installs continue working.
5. self-ca installs become functional for the first time.

## Risks + open questions

- **`--configfile`'s reload semantics:** Does Traefik watch `traefik.yml` for changes and reload? If not, `agenthub reconfigure-tls` needs to recreate Traefik (which we already do). Confirm in the implementation.
- **Permissions on `traefik.yml`:** Should be 0644 (Traefik runs as root inside the container; mount is read-only, so no write conflict).
- **Existing acme.json compatibility:** The `traefik-letsencrypt` volume's `acme.json` should survive the migration. The cert resolver `le` keeps the same name, same storage path.
- **Container restart order on migration:** Migration happens BEFORE compose up. So Traefik picks up new config on first start with new code. No restart loop.

## Out of scope (still deferred)

- "Bring your own cert" follow-up.
- Multi-domain installs.
- Self-CA root rotation tooling.

---

**Execution order:** code → unit tests → manual VM 921 verification → ship PR. Spec stays as the design record.
