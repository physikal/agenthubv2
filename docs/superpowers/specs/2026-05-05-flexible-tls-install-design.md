# Flexible TLS Install — Design

**Date:** 2026-05-05
**Status:** Approved for planning
**Scope:** Installer + compose + operator CLI + server + web UI + docs

## Problem

The v2 installer's Traefik config supports exactly one TLS path: Let's Encrypt via TLS-ALPN-01 challenge (`compose/docker-compose.yml:36`). When ACME fails — most commonly because the host is on an internal-only IP (RFC1918) and Let's Encrypt can't reach `:443` from the public internet — Traefik silently falls back to its built-in `CN=TRAEFIK DEFAULT CERT` self-signed cert. The user sees an invalid-cert browser warning with no signal in the install logs that anything went wrong.

This is a footgun for any operator running an internal-only AgentHub install with a real domain. Concretely: the operator who hits a custom domain like `console.whatever.com` from their LAN gets the same broken experience, regardless of whether they did anything wrong.

The fix is to give the installer a real TLS-strategy surface, eliminate the silent self-signed fallback, and provide first-class operator tooling for managing TLS post-install.

## Goals

1. Support three TLS strategies: public ACME (TLS-ALPN-01), DNS-01 ACME (any provider Traefik supports), and a self-generated CA for fully internal hosts.
2. Default behavior infers the right strategy from supplied env vars; the `localhost` happy path and the existing public-host one-liner stay unchanged.
3. Failure to obtain a valid cert during install is a loud, exit-3 failure — never a silent fallback to the Traefik default cert.
4. Post-install reconfiguration via both CLI (`agenthub reconfigure-tls`) and web UI (admin Settings → TLS card) — no `.env` editing required.
5. TLS health is a first-class signal in `/api/health`, the admin UI, and `agenthub status`, so renewal failures and pre-fix misconfigurations surface where operators already look.
6. Self-CA mode produces a leaf cert that covers the configured domain, its wildcard, and the host's LAN IP — direct-IP access works without a hostname mismatch.

## Non-goals

- "Bring your own cert" (paste cert + key from an external wildcard). Out of scope; could be a follow-up.
- Multi-domain installs (one Traefik serving multiple unrelated `Host()` rules with different cert strategies). Out of scope.
- Custom CA chains (the installer's self-CA is a single self-signed root, no intermediate). Out of scope.
- Rotating an existing CA's root key. Self-CA root is set-and-forget for 10 years; renewal-of-leaf is in scope, root-rotation isn't.

## Architecture overview

Three TLS strategies, all terminate at Traefik. The installer picks one, writes the corresponding env block + compose override, brings the stack up, then verifies the cert is valid before declaring success.

```
                            ┌─────────────────────────────────────┐
                            │  Traefik (entrypoints :80/:443)     │
                            └───────┬─────────────────────────────┘
                                    │
         ┌──────────────────────────┼──────────────────────────┐
         │                          │                          │
   public-alpn                   dns-01                     self-ca
   (LE TLS-ALPN-01)         (LE DNS-01 via                 (openssl-
                            lego provider)                  generated CA)
         │                          │                          │
   needs :443 reachable     needs DNS provider          needs nothing
   from public internet     API token (env var)         beyond the host
```

A single env var **`AGENTHUB_TLS_MODE`** drives the branch (values: `auto` | `public-alpn` | `dns-01` | `self-ca`).

`auto` (default) infers:

- `DOMAIN=localhost` → today's behavior unchanged (no cert resolver, default self-signed accepted because direct-IP access has no hostname mismatch concern)
- `AGENTHUB_TLS_DNS_PROVIDER` is set → `dns-01`
- otherwise → `public-alpn`

Explicit `AGENTHUB_TLS_MODE=self-ca` is required for self-CA mode (no inference path — it's the air-gap escape hatch, not a fallback).

## Env var contract (additions)

| Var | Required when | Notes |
|---|---|---|
| `AGENTHUB_TLS_MODE` | optional | `auto` (default), `public-alpn`, `dns-01`, `self-ca` |
| `AGENTHUB_TLS_EMAIL` | ACME modes (existing var, semantics unchanged) | Let's Encrypt expiry notifications |
| `AGENTHUB_TLS_DNS_PROVIDER` | `TLS_MODE=dns-01` | lego provider name (`cloudflare`, `route53`, `digitalocean`, etc.) |
| `AGENTHUB_CLOUDFLARE_API_TOKEN` | provider=cloudflare | Convenience var; installer remaps to `CF_DNS_API_TOKEN` for Traefik |
| (lego env vars for non-CF providers) | other providers | User pre-exports; installer inspects `process.env` against `lego-providers.json` and forwards required vars to Traefik's `environment:` block |
| `AGENTHUB_LAN_IP` | optional, self-ca only | Override auto-detected LAN IP for the leaf cert SAN |

`AGENTHUB_TLS_MODE=self-ca` needs no further env vars beyond optional `AGENTHUB_LAN_IP`. The `localhost` happy path needs nothing new — the existing one-liner is unchanged.

### Headless one-liners — final shape

| Use case | Env vars beyond today's |
|---|---|
| Public host (today, unchanged) | none |
| Internal + Cloudflare DNS-01 | `AGENTHUB_TLS_DNS_PROVIDER=cloudflare AGENTHUB_CLOUDFLARE_API_TOKEN=…` |
| Internal + other DNS provider | `AGENTHUB_TLS_DNS_PROVIDER=route53` plus that provider's native lego env vars (pre-exported) |
| Internal + self-CA | `AGENTHUB_TLS_MODE=self-ca` |

## Compose shape

`compose/docker-compose.yml` stays canonical and TLS-mode-agnostic. The cert-resolver `command:` flags currently in the base compose move out — the base compose's Traefik service has no `--certificatesresolvers.*` flags at all. The installer renders TLS-mode-specific bits into `compose/traefik.override.yml`, and writes `COMPOSE_FILE=docker-compose.yml:traefik.override.yml` into `compose/.env` so docker compose picks up both files automatically.

**Why an override file rather than templating the main compose:** the main `docker-compose.yml` stays diffable across upgrades (a regenerated full compose file would create noisy diffs and break operators who've made local edits). The override is a regenerated artifact owned by the installer and `agenthub reconfigure-tls`; treating it as derived state means we can always rewrite it cleanly.

**`localhost` mode:** the installer skips override generation entirely. Without a cert resolver, Traefik just serves its built-in self-signed cert as the default — exactly what localhost installs want, and we no longer make a useless ACME attempt for the literal hostname `localhost` like today's compose does.

**Migration on first update after this PR lands:** the new agenthub-server detects on boot whether `compose/traefik.override.yml` exists. If not, it runs a one-shot migration that reads `.env`'s `DOMAIN` and `TLS_EMAIL`, infers the mode (`localhost` → no override, otherwise `public-alpn`), and writes the override before Traefik restarts. Existing public-host installs upgrade without operator intervention; localhost installs upgrade without an override file appearing.

### Override examples

`TLS_MODE=public-alpn` (what's currently in `docker-compose.yml`, just relocated):

```yaml
services:
  traefik:
    command:
      - --certificatesresolvers.le.acme.tlschallenge=true
      - --certificatesresolvers.le.acme.email=${TLS_EMAIL}
      - --certificatesresolvers.le.acme.storage=/letsencrypt/acme.json
```

`TLS_MODE=dns-01`, provider=cloudflare:

```yaml
services:
  traefik:
    command:
      - --certificatesresolvers.le.acme.dnschallenge=true
      - --certificatesresolvers.le.acme.dnschallenge.provider=cloudflare
      - --certificatesresolvers.le.acme.email=${TLS_EMAIL}
      - --certificatesresolvers.le.acme.storage=/letsencrypt/acme.json
    environment:
      CF_DNS_API_TOKEN: ${CF_DNS_API_TOKEN}
```

`TLS_MODE=self-ca`:

```yaml
services:
  traefik:
    command:
      - --providers.file.directory=/etc/traefik/dynamic
    volumes:
      - traefik-self-ca:/etc/traefik/dynamic:ro
    depends_on:
      traefik-self-ca-init:
        condition: service_completed_successfully

  traefik-self-ca-init:
    image: alpine:3.20
    restart: "no"
    environment:
      DOMAIN: ${DOMAIN}
      LAN_IP: ${AGENTHUB_LAN_IP}
    command: ["/init.sh"]
    volumes:
      - traefik-self-ca:/out
      - ../scripts/self-ca-init.sh:/init.sh:ro

  traefik-self-ca-renew:
    image: alpine:3.20
    restart: unless-stopped
    environment:
      DOMAIN: ${DOMAIN}
      LAN_IP: ${AGENTHUB_LAN_IP}
    command: ["/renew.sh"]   # cron-style daily check; regenerates leaf if <30d
    volumes:
      - traefik-self-ca:/out
      - ../scripts/self-ca-renew.sh:/renew.sh:ro

volumes:
  traefik-self-ca:
```

The `Path('/.well-known/agenthub-ca.crt')` and `PathPrefix('/install/ca')` routes that serve the CA cert + install page on the HTTP entrypoint are added to the override only when `TLS_MODE=self-ca`.

## TUI flow

```
mode → domain → ┬─ localhost ──→ public-host → admin → confirm
                │
                └─ real domain ──→ tls-strategy ──┬─ public ────→ tls-email ─────────────────→ admin
                                                  │
                                                  ├─ dns-01 ───→ tls-email → tls-dns(provider+creds) → admin
                                                  │
                                                  └─ self-ca ──→ tls-self-ca(LAN IP) ─────────→ admin
```

### `tls-strategy` step

Three-option `SelectInput` with one-line "use this when…" hints. No fourth `auto` option in the TUI — auto exists only as a headless default.

```
How should TLS work for agenthub.physhlab.com?

  ► Public ACME — Let's Encrypt cert. Needs the box reachable on :443
                  from the public internet.
    DNS challenge — Let's Encrypt cert via your DNS provider's API.
                    Use this for internal-only hosts. (Cloudflare et al.)
    Self-signed CA — generate a private CA on this host. No internet
                     needed. You import the CA cert on each device.
```

### `tls-dns` sub-step (multi-prompt, mirrors `DokployRemoteStep`)

1. `SelectInput` provider: `Cloudflare` | `Other (lego provider)`
2. Cloudflare branch: masked `TextInput` for the API token. Pre-flight (Section "Pre-flight validation") runs immediately on submit; failure returns to step 2 with the API error inline.
3. Other branch: free-text `TextInput` for the lego provider name. On submit: installer reads `process.env`, looks up the required env vars for that provider in `lego-providers.json` (a static mapping shipped in the repo, covering all ~80 providers Traefik supports via lego — keys are provider names like `route53` or `digitalocean`, values are the required env var names like `["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"]`). If any required vars are missing from `process.env`, exits cleanly with `Set these env vars and re-run: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION` (verbatim copy-paste-friendly). If all present, the installer forwards them to Traefik's `environment:` block in the override.

The provider list itself is generated from lego's source (`go-acme/lego`'s `providers/dns/*` packages) at repo-build time and committed to the repo — no runtime dependency on lego, no risk of falling out of sync mid-install.

### `tls-self-ca` sub-step

Single screen showing detected LAN IP with confirm/edit:

```
Detected LAN IP: 192.168.4.36

  ► Use this in the cert SAN
    Enter a different IP / hostname
```

Multi-IP / multi-hostname entry uses comma separation in the edit field. Headless override: `AGENTHUB_LAN_IP=192.168.4.36,10.0.0.5`.

### Confirm screen additions

Existing confirm screen (`app.tsx:165`) gains a `TLS:` line summarizing the chosen strategy: `TLS: dns-01 (cloudflare)` or `TLS: self-ca (LAN IP 192.168.4.36)`. Lets the user catch a wrong selection before launch.

## Self-CA internals

A new init container `traefik-self-ca-init` runs once before Traefik on first start, idempotent on re-run. The script (`scripts/self-ca-init.sh`):

```bash
#!/bin/sh
set -eu
DOMAIN="${DOMAIN}"
LAN_IP="${LAN_IP:-127.0.0.1}"
OUT=/out
DAYS_CA=3650            # 10y CA — set-and-forget
DAYS_LEAF=825           # 27mo — within Apple's 825-day max + leaves headroom

apk add --no-cache openssl >/dev/null

# Idempotent: only generate if missing or REGEN=1
if [ -f "$OUT/ca.crt" ] && [ -f "$OUT/leaf.crt" ] && [ -z "${REGEN:-}" ]; then
  echo "[self-ca-init] cert + CA already present; skipping (set REGEN=1 to force)"
  exit 0
fi

# CA — only generate if missing (we never regenerate the root unless explicitly cleaned)
if [ ! -f "$OUT/ca.crt" ]; then
  openssl genrsa -out "$OUT/ca.key" 4096
  openssl req -x509 -new -nodes -key "$OUT/ca.key" -sha256 -days "$DAYS_CA" \
    -out "$OUT/ca.crt" -subj "/CN=AgentHub Self-CA ($DOMAIN)"
fi

# Leaf, signed by our CA, with SANs covering DOMAIN + wildcard + LAN IP
SAN="DNS:${DOMAIN},DNS:*.${DOMAIN},IP:${LAN_IP}"
# Comma-split LAN_IP for multi-interface hosts
echo "$LAN_IP" | tr ',' '\n' | while read ip; do
  [ -n "$ip" ] && SAN="${SAN},IP:${ip}"
done

openssl req -new -newkey rsa:2048 -nodes -keyout "$OUT/leaf.key" \
  -out "$OUT/leaf.csr" -subj "/CN=$DOMAIN"
openssl x509 -req -in "$OUT/leaf.csr" -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" \
  -CAcreateserial -out "$OUT/leaf.crt" -days "$DAYS_LEAF" -sha256 \
  -extfile <(printf "subjectAltName=%s\n" "$SAN")

chmod 0600 "$OUT/ca.key" "$OUT/leaf.key"
chmod 0644 "$OUT/ca.crt" "$OUT/leaf.crt"

# Traefik dynamic-config file pointing at the leaf
cat > "$OUT/self-ca.yml" <<EOF
tls:
  certificates:
    - certFile: /etc/traefik/dynamic/leaf.crt
      keyFile: /etc/traefik/dynamic/leaf.key
  stores:
    default:
      defaultCertificate:
        certFile: /etc/traefik/dynamic/leaf.crt
        keyFile: /etc/traefik/dynamic/leaf.key
EOF

# Touch a stamp so the renew sidecar can read last-renewal timestamp
date -Iseconds > "$OUT/last-renewed"
```

**Persistence:** named Docker volume `traefik-self-ca`. Survives container recreations and image updates. Backed up alongside the existing `traefik-letsencrypt` volume (operator's responsibility, but documented).

**Renewal:** a sidecar container `traefik-self-ca-renew` runs a daily cron-style loop, reads days-remaining on `leaf.crt`, regenerates if < 30d. CA root is untouched — only the leaf rotates, so devices that already trust the root never need to re-trust. The sidecar uses the same volume; Traefik's file-provider hot-reloads on file change without a restart.

`agenthub reconfigure-tls --regen-cert` runs the init container with `REGEN=1` for a forced regeneration (e.g. after manual SAN list changes).

## CA distribution

The chicken-and-egg problem (browser can't fetch CA from a URL it doesn't trust yet) is solved at the Traefik layer:

- `Path('/.well-known/agenthub-ca.crt')` on the `web` (HTTP) entrypoint serves the CA cert directly via Traefik's file middleware — no agenthub-server involvement, no redirect to HTTPS.
- `PathPrefix('/install/ca')` on the same HTTP entrypoint serves a static HTML page with platform-specific trust instructions (see Section "Install-CA page").
- All other `:80` traffic still redirects to `:443` via the existing `entrypoints.web.http.redirections` rule, so we don't open a generic HTTP surface.

The success screen output for self-CA installs is one line:

```
Devices on your LAN: open http://agenthub.physhlab.com/install/ca to trust the CA.
```

## Install-CA page

A static HTML file at `compose/static/install-ca/index.html`, mounted into Traefik. Contains:

- User-Agent–aware tab pre-selection (macOS / iOS / Android / Linux / Windows)
- One copy-paste command per platform, e.g. macOS: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/Downloads/agenthub-ca.crt`
- A download button that fetches `/.well-known/agenthub-ca.crt`
- A short GIF or screencast for GUI-only paths (iOS Settings → Profile → trust toggle)
- Explicit "you only need to do this once per device" framing so users don't worry it's per-app

Pre-bundled in the repo (no build step), tabbed with vanilla CSS/JS. ~150 LOC total.

## `agenthub reconfigure-tls` subcommand

Adds one verb to `scripts/agenthub`. Two invocation modes:

```bash
# Interactive — drops into the installer's TUI but only runs the TLS sub-tree
agenthub reconfigure-tls

# Headless — same env-var contract as the installer
AGENTHUB_TLS_MODE=dns-01 \
AGENTHUB_TLS_DNS_PROVIDER=cloudflare \
AGENTHUB_CLOUDFLARE_API_TOKEN=… \
agenthub reconfigure-tls --non-interactive
```

Behavior:

1. Reads existing `compose/.env`, merges in new TLS-related answers (preserves everything else).
2. Backs up `compose/traefik.override.yml` to `compose/traefik.override.yml.prev`.
3. Regenerates `compose/traefik.override.yml`.
4. `docker compose up -d traefik` (only Traefik is recreated — agenthub-server and Infisical untouched, no app downtime).
5. Waits up to 90s for cert validity (loud-failure gate from Section "Loud-failure semantics").
6. On failure with `--rollback-on-failure` (default): swaps `traefik.override.yml.prev` back, re-runs `docker compose up -d traefik`, exits 3 with the failure reason.
7. `--regen-cert` flag (self-CA only) forces re-issuance of the leaf cert even if config is unchanged — i.e. the in-app "Force renew" button calls this.

The TUI sub-tree is reused via a new `runReconfigure` entry point in `packages/installer` that mounts only the `tls-strategy` / `tls-dns` / `tls-self-ca` steps (skipping mode / domain / admin / Infisical bootstrap).

## Loud-failure semantics

The gate lives in `headless.ts`'s `probeFrontDoor`. Today it does a reachability check via `curl -ksf --resolve <domain>:443:127.0.0.1` for up to 30s. The new behavior:

```typescript
async function probeFrontDoor(domain: string, mode: TlsMode): Promise<void> {
  // 1. Reachability loop (existing) — up to 90s in ACME modes, 15s for self-ca
  await waitForFrontDoorReachable(domain, mode === 'self-ca' ? 15_000 : 90_000);

  // 2. Cert validity check (new)
  const cert = await readServingCert(domain);  // openssl s_client one-shot
  if (cert.issuerCN === 'TRAEFIK DEFAULT CERT') {
    throw new InstallError(
      `Traefik is serving its default self-signed cert for ${domain}. ` +
      `ACME ${mode === 'public-alpn' ? 'TLS-ALPN-01' : 'DNS-01'} did not complete. ` +
      `Check 'docker logs agenthub-traefik-1 | grep -i acme' for the reason. ` +
      explainCommonAcmeFailures(mode),
    );
  }
  if (mode === 'self-ca' && cert.issuerCN.indexOf('AgentHub Self-CA') === -1) {
    throw new InstallError(
      `Self-CA mode selected but the serving cert isn't signed by AgentHub's self-CA. ` +
      `Check 'docker logs agenthub-traefik-self-ca-init-1' for init failures.`,
    );
  }
  // optionally verify the cert covers DOMAIN as a SAN — defense in depth
}
```

`explainCommonAcmeFailures()` returns mode-specific hints:

- `dns-01`: "Common causes: wrong API token, token lacks the right zone, Cloudflare email mismatch, propagation timeout."
- `public-alpn`: "Common causes: port 443 not reachable from the public internet, DNS A record missing or wrong, ISP blocks inbound :443."

Failure exits 3 (existing "install failure" code). The orchestrator (`scripts/install.sh` and `scripts/quick-install.sh`) already surfaces non-zero exits with `[error]` framing, so no changes there.

## Pre-flight validation

Before flipping config, the installer probes whether the chosen mode will actually work — catching ~80% of failures at the *prompt* layer instead of the *cert-issuance* layer.

| Mode | Pre-flight check | Cost |
|---|---|---|
| `public-alpn` | DNS-resolve the domain; check the resolved IP matches the host's outbound IP. Warn loudly if no public IP at all. | 1 DNS lookup + 1 HTTP request to ipify.org |
| `dns-01` (Cloudflare) | One API call to `https://api.cloudflare.com/client/v4/zones?name=<root-of-domain>` with the token. Confirms token is valid AND has access to a zone matching the domain. | 1 API call |
| `dns-01` (other) | Skipped — provider-specific check is too varied to be worth maintaining. | 0 |
| `self-ca` | Skipped — openssl is local, nothing external to probe. | 0 |

Failure surfaces the specific reason and asks the user to fix the input rather than entering a 90s ACME timeout. Skippable via `--skip-preflight` for users who know better than the check (e.g. testing an offline DNS provider).

Lives in `packages/installer/src/lib/tls/preflight.ts` (~80 LOC).

## TLS health surface

Three surfaces, one underlying check (`packages/server/src/services/tls/health.ts`).

```typescript
export interface TlsHealth {
  ok: boolean;
  domain: string;
  resolver: 'public-alpn' | 'dns-01' | 'self-ca' | 'default-fallback';
  issuer: string;
  notBefore: string;
  notAfter: string;
  daysToExpiry: number;
  warnings: string[];   // [] when ok; e.g. "expires in 9 days", "default cert"
}
```

Implementation: `openssl s_client -connect 127.0.0.1:443 -servername $DOMAIN -showcerts < /dev/null` from inside the agenthub-server container, parse the issuer + dates. Cached for 60s to avoid hammering Traefik on health-check loops. Detection of `default-fallback` is via `issuerCN === 'TRAEFIK DEFAULT CERT'`.

### Surface 1 — `GET /api/health`

Existing endpoint gains a `tls: TlsHealth` field. Backwards-compatible (existing `{ ok: true }` consumers still work).

### Surface 2 — Admin Settings page

Small "TLS" card next to the existing "Version" card.

```
┌─ TLS ─────────────────────────────────────────────┐
│  ✓  Let's Encrypt (DNS-01 via Cloudflare)         │
│     Valid for agenthub.physhlab.com               │
│     Expires in 73 days (renewing automatically)   │
│                                                    │
│  [ Reconfigure TLS ]   [ Force renew ]   [ Test ]│
└────────────────────────────────────────────────────┘
```

States:

- **OK** (green check): cert valid, > 14 days to expiry, resolver matches `.env`.
- **WARN** (yellow): valid cert, < 14 days to expiry. Auto-renewal should kick in but surfacing makes it visible.
- **ERROR** (red): serving `TRAEFIK DEFAULT CERT`, expired, or hostname mismatch. Triggers the migration banner (Section "Migration nudge").

Three buttons:

- **Reconfigure TLS** → opens an in-app modal walking through the TLS-strategy / provider / token flow (same step components as TUI, rendered via React). Submit hits `POST /api/admin/tls/reconfigure` which is a thin server-side wrapper around `agenthub reconfigure-tls --non-interactive`.
- **Force renew** → `POST /api/admin/tls/renew`. Self-CA: triggers init container with `REGEN=1`. LE modes: deletes `acme.json` and restarts Traefik to force a fresh issuance.
- **Test** → `POST /api/admin/tls/test`. Runs the same probe as the loud-failure gate, displays the result inline (issuer, expiry, SANs, ok/warning/error).

### Surface 3 — `agenthub status`

Existing CLI gains one extra line:

```
$ agenthub status
agenthub      running    on agenthub.physhlab.com
TLS           ok         LE (DNS-01) — 73d remaining
```

Or, in a broken state:

```
TLS           WARN       serving Traefik default cert — run 'agenthub reconfigure-tls'
```

## Migration nudge for pre-fix installs

On any v2 install where `/api/health` reports `tls.resolver === 'default-fallback'`, the admin UI shows a one-time persistent banner at the top of the layout:

> ⚠ TLS misconfigured — your site is serving Traefik's default self-signed cert.
> [Fix now]   [Dismiss]

`[Fix now]` opens the Reconfigure TLS modal (same as the Settings card button). `[Dismiss]` writes a key to localStorage so the banner doesn't reappear on the same browser; it'll still appear in the Settings TLS card and the `/api/health` JSON, so the signal isn't lost.

This is the discovery mechanism for installs that pre-date this fix. Coupled to the health surface, not to the update flow.

## Web UI Reconfigure TLS modal

A new component `packages/web/src/components/tls/ReconfigureTlsModal.tsx`. Walks through the same step machine as the TUI but rendered as a multi-step modal. State machine:

```
strategy → ┬─ public-alpn ──→ email ─────────────────────────────→ confirm
           │
           ├─ dns-01 ───────→ email → provider ──┬─ cloudflare → token (masked) → confirm
           │                                     │
           │                                     └─ other ─────→ provider name → "set these env vars on the host" → cancel/exit
           │
           └─ self-ca ──────→ LAN IP confirm ───────────────────→ confirm
```

The "Other provider" branch in the web UI doesn't accept env vars in-modal (web UI is one step removed from the host's process env). Instead, it tells the user which env vars to set and asks them to run `agenthub reconfigure-tls --non-interactive` from the host shell. This matches the CLI semantics and avoids storing arbitrary secrets in the web UI.

Confirm step shows a summary + the loud-failure semantics: "Applying will recreate Traefik. If the new cert can't be issued within 90 seconds, the previous TLS config will be restored automatically."

Submit hits `POST /api/admin/tls/reconfigure` with the answers. Server-side: writes the new override, runs `docker compose up -d traefik`, waits for the loud-failure probe, returns success or the failure reason. The modal streams progress via SSE — same pattern as the existing update-logs endpoint (`packages/server/src/routes/admin.ts`'s `/api/admin/update/logs` handler using Hono's `streamSSE`).

## File layout summary

| Path | Status | Purpose |
|---|---|---|
| `compose/docker-compose.yml` | modified | TLS-mode-specific blocks moved out into override |
| `compose/traefik.override.yml` | new (generated) | TLS-mode-specific Traefik config |
| `compose/traefik.override.yml.prev` | new (generated) | Rollback snapshot |
| `compose/static/install-ca/index.html` | new | Trust-CA install instructions page |
| `compose/static/install-ca/style.css` | new | Page styling |
| `compose/.env.example` | modified | Documents new env vars |
| `scripts/self-ca-init.sh` | new | Generates self-CA root + leaf |
| `scripts/self-ca-renew.sh` | new | Daily check + leaf regen if < 30d |
| `scripts/agenthub` | modified | Adds `reconfigure-tls` verb |
| `packages/installer/src/lib/config.ts` | modified | New `tls*` fields on `InstallConfig` |
| `packages/installer/src/lib/tls/preflight.ts` | new | Pre-flight validation per mode |
| `packages/installer/src/lib/tls/lego-providers.json` | new | Provider → required env vars mapping |
| `packages/installer/src/lib/tls/render-override.ts` | new | Renders `traefik.override.yml` from config |
| `packages/installer/src/lib/tls/lan-ip.ts` | new | Auto-detects host LAN IP |
| `packages/installer/src/app.tsx` | modified | New `tls-strategy`, `tls-dns`, `tls-self-ca` steps |
| `packages/installer/src/headless.ts` | modified | New env vars in override schema; loud-failure cert check |
| `packages/installer/src/run.ts` | modified | Calls render-override before compose-up; runs preflight |
| `packages/installer/src/reconfigure.ts` | new | Entry point for `agenthub reconfigure-tls` |
| `packages/server/src/services/tls/health.ts` | new | TLS health probe |
| `packages/server/src/routes/admin/tls.ts` | new | `/api/admin/tls/{reconfigure,renew,test}` handlers |
| `packages/server/src/routes/health.ts` | modified | Adds `tls` field to response |
| `packages/web/src/components/tls/ReconfigureTlsModal.tsx` | new | Web UI sub-flow |
| `packages/web/src/components/tls/TlsCard.tsx` | new | Settings page card |
| `packages/web/src/components/tls/MigrationBanner.tsx` | new | Top-of-app nudge |
| `packages/web/src/pages/Settings.tsx` | modified | Mounts TlsCard |
| `packages/web/src/Layout.tsx` | modified | Mounts MigrationBanner |
| `docs/install/agents.md` | modified | Adds `AGENTHUB_TLS_*` env var table |
| `docs/install/humans.md` | modified | Documents TUI TLS step |
| `docs/troubleshooting.md` | modified | Adds TLS section |
| `docs/install/tls-modes.md` | new | Detailed reference for each TLS mode |
| Obsidian: `Services/AgentHub v2/Install & Operations.md` | modified | Updates TLS section + custom-domain guidance |

## Testing strategy

### Unit tests

- `lib/tls/render-override.test.ts` — every TLS mode → snapshot of generated override YAML
- `lib/tls/preflight.test.ts` — each mode's preflight, including the failure-message paths (DNS mismatch, Cloudflare 401, etc., mocked at the fetch boundary)
- `lib/tls/lan-ip.test.ts` — LAN IP detection across `eth0` / `en0` / multi-interface mocks
- `services/tls/health.test.ts` — issuer parsing for LE / self-CA / default-fallback fixtures
- `lib/config.test.ts` — `applyEnvOverrides` extended for new vars; `missingRequiredForHeadless` extended for `dns-01`

### Integration tests

- New section in `scripts/e2e-full.js` (the existing 21-check E2E):
  - Self-CA install: install with `AGENTHUB_TLS_MODE=self-ca`, fetch `/.well-known/agenthub-ca.crt`, verify chain back to ours, verify leaf SANs include domain + LAN IP.
  - Reconfigure-tls round-trip: install in `public-alpn` mode (mocked LE staging), reconfigure to `self-ca`, verify cert flips. Then reconfigure back; verify rollback after a forced failure.
  - Loud-failure gate: install with `AGENTHUB_TLS_MODE=dns-01 AGENTHUB_CLOUDFLARE_API_TOKEN=invalid`, expect exit 3 within 90s with the actionable error message.

### Manual verification checklist

1. Fix the existing `.4.36` install via `agenthub reconfigure-tls --non-interactive` with `AGENTHUB_TLS_MODE=dns-01 AGENTHUB_TLS_DNS_PROVIDER=cloudflare AGENTHUB_CLOUDFLARE_API_TOKEN=…`. Verify `agenthub.physhlab.com` serves a Let's Encrypt cert.
2. Fresh install on a new internal-only Proxmox VM with self-CA mode. Verify `/install/ca` page works on the LAN, CA installs cleanly on macOS + iOS, browser shows green padlock.
3. Power-cycle the host and confirm self-CA leaf survives container restart, Traefik picks up the cert without manual intervention.
4. Force-expire the leaf (set `DAYS_LEAF=1` in a test override) and confirm the renew sidecar regenerates within 24h.
5. Web UI: trigger a Reconfigure TLS to a deliberately bad config; confirm rollback restores the working state.
6. `agenthub status` shows the right TLS line in all three states (ok, warn-near-expiry, error-default-cert).

## Migration / rollout

1. The PR lands as additive — no env var or config behavior changes for existing **`localhost` installs**.
2. Existing **public-domain installs** (i.e. running `tlschallenge=true` from `docker-compose.yml`) keep working: their `auto`-mode inference picks `public-alpn`, the override file is regenerated to match what they have, no cert change.
3. For the existing **`.4.36` install**, the rollout is one command: `agenthub reconfigure-tls` after the update lands. This is the manual fix that proves the new CLI works end-to-end before downstream users hit it.
4. Any pre-fix install that's currently serving `TRAEFIK DEFAULT CERT` will get the migration banner on next admin-UI load. They'll never silently miss the misconfiguration after this PR.

## Open questions resolved during brainstorming

- **TLS strategy scope:** DNS-01 + self-CA, no "bring your own cert" (deferred).
- **DNS provider scope:** Cloudflare in TUI, all ~80 lego providers via env-var pre-export.
- **Default behavior:** auto mode + loud failure on cert validity check, no silent self-signed fallback.
- **Reconfiguration discovery:** TLS health surface (not coupled to update flow).
- **CA distribution:** HTTP `:80` exemption for `/.well-known/agenthub-ca.crt` and `/install/ca`.
- **Self-CA leaf coverage:** domain + wildcard + LAN IP.
- **Rollback default:** ON (safe default; `--no-rollback` opt-out for power users).
- **Web UI parity:** Reconfigure TLS sub-flow in admin UI matches CLI semantics.

## Out of scope (follow-ups, not blockers)

- "Bring your own cert" path (paste cert + key for users with existing wildcards).
- Custom CA chain support (intermediate cert in self-CA).
- Multi-domain installs.
- Self-CA root rotation tooling.
- agentdeploy MCP awareness of self-CA trust state on deploy targets.

---

## Postscript — implementation deltas (2026-05-06)

End-to-end validation on Proxmox VM 918 ([issue #64](https://github.com/physikal/agenthubv2/issues/64)) surfaced 5 bugs in PR #62; all fixed in PRs #65-#69. The two notable design-vs-reality deltas:

1. **Override flags are TRAEFIK_* env vars, not a `command:` array.** The "Override examples" section above shows compose `services.traefik.command:` arrays. That doesn't work: docker-compose merges list-typed fields like `command:` by REPLACING — putting TLS flags in the override's `command:` strips the base's `--providers.docker=true`, entrypoints, and redirect, leaving Traefik with only the override flags. PR #69 converted all override flags to `services.traefik.environment:` with `TRAEFIK_*`-prefixed vars (Traefik's documented env-var equivalents for every CLI flag), which compose merges as a dict. Result: base + override coexist correctly. Snapshot tests now assert `traefik.command === undefined` for every override mode as a regression guard.

2. **Probe parsing pipes through `openssl x509`.** `s_client -showcerts` doesn't emit `notBefore=…`/`notAfter=…` lines (it emits `NotBefore: …; NotAfter: …` on a single `v:` line). The original probe regex never matched, so `/api/health.tls` and the install loud-failure gate always failed. PR #69 pipes s_client through `openssl x509 -noout -subject -issuer -dates` to get the canonical key=value form the parser expects.

Plus minor fixes: PR #66 (refspec accumulation in `scripts/agenthub`), PR #67 (SHA-aware update probe handles docs-only updates), PR #68 (reconfigure-tls now sets `COMPOSE_FILE` so localhost→real-domain migration works).

The architectural concept of the spec — three TLS strategies, override-file pattern, loud-failure gate, web UI parity — is preserved. Only the override's *encoding* changed (env vars vs. command flags). User-facing surface unchanged.
