# Access modes

AgentHub supports two access modes. Choose based on how the install is reached.

| Mode | When to use | Setup cost |
|---|---|---|
| `lan` (default) | Accessed from your own LAN | Zero. HTTP on :80, no TLS, no cert ceremony. |
| `public` | Host is directly reachable on the public internet | Let's Encrypt cert. Two sub-modes below. |

A third mode, `tunnel` (Cloudflare Tunnel), is coming in a follow-up release.

## lan (default)

No TLS. AgentHub binds on `:80` and is reachable via `http://<host>` from any device on the same network. Nothing to configure.

This is the right choice for ~99% of self-hosted installs. If your devices are on the same LAN as the server, you don't need HTTPS — traffic never leaves a trusted network.

**No env vars required** beyond `AGENTHUB_DOMAIN`, `AGENTHUB_MODE`, and `AGENTHUB_ADMIN_PASSWORD`.

## public

Let's Encrypt-issued cert. Traefik handles HTTPS on `:443`; HTTP on `:80` redirects to `:443`.

Set `AGENTHUB_ACCESS_MODE=public` and pick a sub-mode:

### public-alpn

TLS-ALPN-01 challenge. LE connects to your host on `:443` during cert issuance. Requires the host's port 443 to be reachable from the public internet (port forwarding / public IP).

**Required:** `AGENTHUB_TLS_EMAIL=ops@example.com`

**Common failures:**
- ISP blocks inbound `:443` → use `dns-01` instead
- DNS A record missing or wrong → `dig <domain>`

### dns-01

DNS-01 challenge. LE proves domain ownership via a TXT record that Traefik (via lego) provisions automatically. Works for internal-only hosts — the host never needs to be reachable from outside.

**Required:**
- `AGENTHUB_TLS_EMAIL`
- `AGENTHUB_TLS_DNS_PROVIDER` — lego provider name. Common: `cloudflare`, `route53`, `digitalocean`, `hetzner`, `gandi`, `linode`, `desec`, `namecheap`. Full list (~80 providers) at <https://go-acme.github.io/lego/dns/>.
- Provider API token:
  - Cloudflare: `AGENTHUB_CLOUDFLARE_API_TOKEN` (AgentHub remaps this to the lego-native `CF_DNS_API_TOKEN`)
  - Others: export the lego-native env vars (`AWS_ACCESS_KEY_ID` for Route 53, `DO_AUTH_TOKEN` for DigitalOcean, etc.) before running the installer. AgentHub forwards them verbatim into the Traefik container. Provider-specific var names: <https://go-acme.github.io/lego/dns/>

A pre-flight check validates the Cloudflare token and zone access before writing config. Bypass with `AGENTHUB_SKIP_PREFLIGHT=1`.

## Env var reference

| Var | Default | Notes |
|---|---|---|
| `AGENTHUB_ACCESS_MODE` | `lan` | `lan` or `public` |
| `AGENTHUB_TLS_MODE` | `public-alpn` | Only when `ACCESS_MODE=public`: `public-alpn` or `dns-01` |
| `AGENTHUB_TLS_EMAIL` | — | Required when `ACCESS_MODE=public` |
| `AGENTHUB_TLS_DNS_PROVIDER` | — | Required when `TLS_MODE=dns-01` |

## Changing modes after install

```bash
agenthub reconfigure-access
```

Interactive — walks through the same three-question flow as the TUI. The old verb `agenthub reconfigure-tls` still works but is deprecated.

To switch non-interactively:

```bash
AGENTHUB_ACCESS_MODE=public \
AGENTHUB_TLS_MODE=dns-01 \
AGENTHUB_TLS_EMAIL=ops@example.com \
AGENTHUB_TLS_DNS_PROVIDER=cloudflare \
AGENTHUB_CLOUDFLARE_API_TOKEN=<token> \
agenthub reconfigure-access --non-interactive
```

## Infisical admin console (`:8443`)

The Infisical secret-store UI is exposed on `:8443` in both modes:

| Mode | URL | TLS |
|---|---|---|
| `lan` | `http://<host>:8443/` | none (matches the rest of lan mode) |
| `public` | `https://<host>:8443/` | Traefik's default self-signed cert (admin-only, not Let's Encrypt) |

Login credentials are accessible from the AgentHub UI under **Secrets → Reveal Infisical admin login** (admin-only, gated by AgentHub password re-entry) — Infisical itself disables self-registration and has no SMTP password reset wired up, so this is the canonical recovery path.

## Customizing exposed ports

By default Traefik binds host ports `80` (always), `443` (public mode only), and `8443` (Infisical console). Override via `compose/.env` if you need to co-locate AgentHub with another web service on the same box:

```
AGENTHUB_HTTP_PORT=8080
AGENTHUB_HTTPS_PORT=8443     # public mode only; conflicts with default 8443 below — pick non-overlapping ports
AGENTHUB_INFISICAL_PORT=9443
```

Container-side ports are always Traefik's standard `80`/`443`/`8443` — only the host mapping changes. After editing `.env`, run `agenthub restart` to apply.

## Migration from self-CA

Self-CA mode was removed. If your install was running self-CA, `agenthub update` migrates it automatically to `lan` mode (HTTP-only). The cert and CA-distribution sidecar are removed.

**HSTS caveat:** Browsers that previously visited the install over HTTPS may be HSTS-pinned for up to 6 months. After migration to `lan` mode those browsers will refuse `http://`. Fix:
- Chrome: `chrome://net-internals/#hsts` → Delete domain
- Firefox: History → "Forget About This Site" for the hostname
