# LAN-first TLS default

**Date:** 2026-05-13
**Status:** Approved for planning (next session)
**Supersedes:** the four-mode TLS surface introduced by PR #62 + the static-config redesign in `2026-05-12-tls-static-config-redesign.md`

## Problem

PR #62 made TLS a foundational install-time choice with four modes (`auto` / `public-alpn` / `dns-01` / `self-ca`). PR #72's redesign fixed all the implementation bugs in that surface. **But the surface itself is wrong for the actual user.**

The reality:

- AgentHub is a self-hosted tool. ~99% of installs are accessed only from the operator's LAN.
- For LAN-only access, HTTPS isn't valuable — devices are trusted, traffic doesn't leave the LAN, and the cert ceremony (self-CA per-device install, or Let's Encrypt DNS-01 with API token wrangling) is pure friction.
- The first-run user experience requires picking a TLS mode before they've decided how the install will be reached. This is backwards. Most users would pick "I don't care, just work."
- Self-CA mode in particular bakes in a per-device CA-install step that's distro-specific, requires Terminal commands on macOS/Linux, and is a hostile UX for anyone who isn't already comfortable with TLS internals. Validated on VM 923 during the 2026-05-13 cutover: the operator complained immediately.

The fix isn't another TLS mode. It's to **make HTTPS opt-in for the 1% who need it** and **make HTTP-on-LAN the no-brainer default**.

## Goal

A first-run install with no TLS / cert decisions, accessible immediately via `http://<host>` from any LAN device. An obvious, guided opt-in path for the small number of users who want public/external access — without the operator having to understand ACME, DNS challenges, or CA trust models.

## Non-goals

- Continuing to support self-CA. Drop it. The use case (air-gapped install with HTTPS) is rare and the UX cost is large.
- Hand-rolling support for every TLS provider Traefik can talk to. Pick a small, sharp set.

## Mental model — three modes, ranked by friction

| Mode | When | Setup cost |
|---|---|---|
| **`lan-http` (default)** | "I'll access this from my own LAN. I don't need a cert." | Zero. HTTP on :80, no TLS, no warnings. |
| **`tunnel` (one-step external)** | "I want this externally accessible without exposing my LAN." | Cloudflare Tunnel token; CF terminates TLS at their edge. |
| **`public-tls` (direct exposure)** | "I want my host to be the public endpoint." | Either public-alpn (port 443 reachable) or dns-01 (DNS provider API token). |

Self-CA and the four-mode surface in PR #62 collapse into this. No surface is lost — direct dns-01 / public-alpn remain available under `public-tls`. Self-CA disappears.

### `lan-http` default

- Traefik runs with `web` entrypoint on :80 only. No `websecure` entrypoint. No cert resolver. No redirect.
- `AGENTHUB_HOST_RULE=Host(\`${DOMAIN}\`)` (or `PathPrefix(\`/\`)` if `DOMAIN=localhost`).
- `AGENTHUB_PUBLIC_URL=http://${DOMAIN}`.
- The install success message reads:
  ```
  AgentHub is up at http://<domain-or-ip>
  ```
- The TUI doesn't even ask about TLS. The mode-selection step is "How will you access this install?" with the three options above.

### `tunnel` mode (Cloudflare Tunnel)

- The operator gives the installer a Cloudflare Tunnel token (created in the CF dashboard or via API).
- The installer adds a `cloudflared` service to the compose stack. It connects out to Cloudflare and routes inbound traffic from `https://<their-cf-hostname>` to the local Traefik on `web:80`.
- Cloudflare terminates TLS at their edge with their own publicly-trusted cert. Every browser trusts it.
- AgentHub's own host stays behind NAT — no port forwarding, no public IP needed, no DNS records to manage. The CF Tunnel handles the connection out.
- This is the right "external access" mode for ~95% of users who want it.

### `public-tls` mode

- Same as today's `public-alpn` or `dns-01`. The operator picks a sub-mode:
  - **public-alpn**: host is reachable on :443 from the public internet
  - **dns-01**: host is internal, but the operator has DNS API access (Cloudflare, Route53, etc.)
- Traefik gets a cert resolver, HTTPS is enabled, HTTP redirects to HTTPS.

## TUI flow (new)

```
mode → ┬─ I'll only access from my LAN ──→ DONE (lan-http)
       │
       ├─ I want external access via Cloudflare Tunnel
       │  └─→ tunnel-token entry → DONE (tunnel)
       │
       └─ I want my host directly reachable on the public internet
          └─→ tls-strategy
             ├─ Port 443 reachable from outside → public-alpn → email → DONE
             └─ Internal only, but I have DNS API → dns-01 → provider + token → DONE
```

The default selection is "LAN only". The user can hit enter and be done.

Headless / env-var contract:

| Var | Required when | Notes |
|---|---|---|
| `AGENTHUB_ACCESS_MODE` | optional | `lan` (default), `tunnel`, `public` |
| `AGENTHUB_TUNNEL_TOKEN` | `ACCESS_MODE=tunnel` | Cloudflare Tunnel token |
| `AGENTHUB_TLS_MODE` | `ACCESS_MODE=public` | `public-alpn` (default) or `dns-01` |
| `AGENTHUB_TLS_EMAIL` | public modes | Let's Encrypt contact email |
| `AGENTHUB_TLS_DNS_PROVIDER` | `TLS_MODE=dns-01` | lego provider name |
| (provider tokens via lego env vars) | provider-specific | Existing contract from PR #62 |

## What the compose layout becomes

- `compose/docker-compose.yml`: stays TLS-agnostic. Traefik service has the `web` entrypoint always; `websecure` is only added when `ACCESS_MODE=public`.
- `compose/traefik.yml` (gitignored, generated): rendered per mode. `lan-http` mode emits a minimal config (entrypoints, providers.docker, no cert resolver). `tunnel` mode emits the same as `lan-http` plus the `redirect-to-https` middleware is gone (no HTTPS at Traefik). `public` mode emits the existing PR #72 shape.
- `compose/dynamic/redirect.yml`: only generated in `public` mode. In `lan-http` / `tunnel`, no redirect needed.
- `compose/traefik.override.yml`: only generated in `public` + `dns-01` mode (DNS env vars).
- New: `compose/tunnel.override.yml` (generated when `ACCESS_MODE=tunnel`): adds the `cloudflared` service with the token from `.env`.

## Migration

Existing installs auto-detect on next `agenthub update`:

- If `DOMAIN=localhost`: maps to `lan-http`.
- If `DOMAIN=real.tld AGENTHUB_TLS_MODE=self-ca`: prompt operator on next install/update to pick `lan-http` (drops self-CA) or `public` + dns-01 (real LE cert). One-line `agenthub reconfigure-tls --interactive`.
- If `DOMAIN=real.tld AGENTHUB_TLS_MODE in (public-alpn|dns-01|auto)`: maps to `public` with the existing TLS sub-mode.

Self-CA mode is removed from the supported set. Migration writes a one-time `[migrate-tls]` log line explaining the change with a link to the docs.

## Web UI

The Settings → TLS card becomes a Settings → Access card:

- Current state: "LAN-only", "Cloudflare Tunnel — `https://<hostname>`", or "Public TLS — `<resolver>`, expires in N days"
- Buttons: `Switch mode`, `Renew cert` (public only), `Test`

The reconfigure modal runs the same three-question flow as the TUI.

## File layout summary

| Path | Change |
|---|---|
| `compose/docker-compose.yml` | Remove `websecure` entrypoint binding; let the generated `traefik.yml` decide. Drop the `:443:443` port mapping from base; the override adds it for `public`/`tunnel` modes. |
| `compose/traefik.yml` (generated) | Per-mode rendering changes |
| `compose/tunnel.override.yml` (new, generated) | Adds `cloudflared` service for tunnel mode |
| `compose/dynamic/redirect.yml` (generated) | Only present in `public` mode |
| `packages/installer/src/lib/access/` (new) | Render helpers for the new mode contract |
| `packages/installer/src/lib/tls/render-*.ts` | Renamed/refactored — TLS rendering is now mode-specific (only the `public` mode generates Traefik TLS config) |
| `packages/installer/src/lib/tls/render-override.ts` | Self-CA branch deleted entirely |
| `packages/installer/src/app.tsx` | New mode-selection step (replaces `tls-strategy`) |
| `packages/installer/src/headless.ts` | New `AGENTHUB_ACCESS_MODE` env var |
| `packages/installer/src/reconfigure*.ts` | Renamed to `reconfigure-access` |
| `scripts/agenthub` | `reconfigure-tls` → `reconfigure-access` (alias keeps old verb working) |
| `scripts/self-ca-*.sh` | Deleted |
| `compose/static/install-ca/` | Deleted |
| `packages/web/src/components/tls/` | Renamed `access/`; TlsCard becomes AccessCard |
| `docs/install/tls-modes.md` | Renamed `access-modes.md`; rewritten around the three-mode model |
| `docs/install/agents.md`, `humans.md` | Updated env-var tables |

## Testing strategy

- **Unit**: new `render-access-config.test.ts` covering each of the three modes; existing TLS tests adapted or deleted.
- **Integration**: extend `scripts/e2e-full.js` with one test per mode — `lan-http` (`curl http://<vm-ip>` works, no cert), `tunnel` (mocked CF token), `public` (mocked LE staging).
- **Manual verify on a fresh VM**: cold install with no TLS env vars at all → access via `http://<vm-ip>` from another LAN device → done in under 5 minutes.

## Migration / rollout

1. Land this PR. Auto-migrate runs on next `agenthub update`.
2. Default for new installs becomes `lan-http`. Operators who explicitly set `AGENTHUB_TLS_MODE=…` keep their mode (mapped to the new contract).
3. `agenthub reconfigure-access` (interactive) shown in the post-install message for operators who want external access.
4. Self-CA prompt-once on migration; users can opt in to `dns-01` if they have a DNS provider, or stay on `lan-http` (drops their cert entirely — the right choice for LAN-only).

## Risks + open questions

- **WebSocket-over-HTTP on a LAN domain**: confirm browsers don't downgrade `ws://` in mixed contexts. Today's WS goes over `wss://` because the page is HTTPS. With `lan-http`, page is HTTP, WS becomes `ws://` — should work; needs verifying in the e2e test.
- **Mixed-content blocks on iframes / external resources**: agenthub-server doesn't currently embed external HTTPS resources, but worth a smoke check.
- **DOMAIN=localhost vs DOMAIN=lan-hostname**: both flow into `lan-http`. The TUI should detect whether the operator entered a real-looking hostname and offer to set DNS or use the IP.
- **Cloudflare Tunnel reconfigure**: tokens are rotateable; the reconfigure-access flow needs to handle replacing a token without breaking the cloudflared connection mid-flight.
- **Backward compat for the `agenthub reconfigure-tls` verb**: keep the alias working for one release, deprecate-warn, remove later.

## Out of scope (true follow-ups)

- "Bring your own cert" path (paste cert + key for users with existing wildcards).
- Multi-domain installs.
- Other tunnel providers (Tailscale Funnel, ngrok, etc.) — Cloudflare Tunnel covers the majority of users; add others on demand.

---

**Execution plan for the next session:** code + unit tests + manual VM verify in this order: (1) render-access-config helpers + tests, (2) base compose refactor (entrypoints + ports become per-mode), (3) install + reconfigure rewires, (4) migrate.ts handles self-CA → lan-http migration, (5) TUI + headless contract, (6) e2e on a fresh VM, (7) docs sweep. Estimate: half-day to one day of focused work.
