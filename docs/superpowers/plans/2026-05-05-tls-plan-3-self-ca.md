# TLS Plan 3: Self-CA Mode + CA Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Depends on:** Plan 1 (foundation) and Plan 2 (DNS-01 mode) merged.

**Goal:** Add a fully-internal self-signed CA mode that generates a CA + leaf cert at install time, distributes the CA via an HTTP-served `/install/ca` page, and auto-renews the leaf via a daily sidecar.

**Architecture:** Two new shell scripts (`self-ca-init.sh` and `self-ca-renew.sh`) live in `scripts/` and run inside alpine sidecar containers. `renderTraefikOverride` gains a `self-ca` branch that emits both sidecars + a Traefik file-provider config that points at the leaf cert from the persistent volume. A new TUI step (`tls-self-ca`) auto-detects the host's LAN IP and confirms with the user. A static HTML page at `compose/static/install-ca/index.html` is served at `http://<domain>/install/ca` with platform-specific trust instructions; `/.well-known/agenthub-ca.crt` serves the CA cert directly. Both routes use Traefik's HTTP (port 80) entrypoint to bypass the chicken-and-egg trust problem.

**Tech Stack:** TypeScript ESM, Bash + openssl (alpine:3.20 base), Vitest, Ink TUI, vanilla HTML/CSS/JS for the install page.

**Spec reference:** Sections "Self-CA internals", "CA distribution", "Install-CA page", and the `tls-self-ca` TUI step in `2026-05-05-flexible-tls-install-design.md`.

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `scripts/self-ca-init.sh` | new | Generates CA root + leaf cert + Traefik file-provider config, idempotent |
| `scripts/self-ca-renew.sh` | new | Daily-cron loop; regenerates leaf when < 30d remaining |
| `compose/static/install-ca/index.html` | new | Static page with trust instructions + CA download |
| `compose/static/install-ca/style.css` | new | Page styling |
| `compose/static/install-ca/script.js` | new | UA-aware tab pre-selection + copy-button behavior |
| `packages/installer/src/lib/tls/lan-ip.ts` | new | Auto-detects host's primary LAN IP |
| `packages/installer/src/lib/tls/lan-ip.test.ts` | new | Mocked-network tests |
| `packages/installer/src/lib/tls/render-override.ts` | modify | Add `self-ca` branch + HTTP routes for `/install/ca` and `/.well-known/agenthub-ca.crt` |
| `packages/installer/src/lib/tls/render-override.test.ts` | modify | Tests for self-ca output |
| `packages/installer/src/lib/config.ts` | modify | New field `lanIp: string` (auto-filled or env-overridden) |
| `packages/installer/src/lib/config.test.ts` | modify | Coverage |
| `packages/installer/src/app.tsx` | modify | New `tls-self-ca` step |
| `packages/installer/src/run.ts` | modify | Pass `lanIp` to render-override |
| `packages/installer/src/headless.ts` | modify | Auto-fill `lanIp` if not provided |
| `compose/.env.example` | modify | Document `AGENTHUB_LAN_IP` |
| `docs/install/agents.md` / `humans.md` | modify | Self-CA examples |

---

## Task 1: LAN IP detection

**Files:**
- Create: `packages/installer/src/lib/tls/lan-ip.ts`
- Create: `packages/installer/src/lib/tls/lan-ip.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/installer/src/lib/tls/lan-ip.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import * as os from "node:os";
import { detectLanIp } from "./lan-ip.js";

describe("detectLanIp", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the first non-loopback IPv4 address", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true } as os.NetworkInterfaceInfo],
      eth0: [{ address: "192.168.4.36", family: "IPv4", internal: false } as os.NetworkInterfaceInfo],
    });
    expect(detectLanIp()).toBe("192.168.4.36");
  });

  it("prefers RFC1918 ranges over public IPs", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      eth0: [
        { address: "8.8.8.8", family: "IPv4", internal: false } as os.NetworkInterfaceInfo,
      ],
      eth1: [
        { address: "192.168.1.5", family: "IPv4", internal: false } as os.NetworkInterfaceInfo,
      ],
    });
    expect(detectLanIp()).toBe("192.168.1.5");
  });

  it("falls back to first non-loopback when no RFC1918 present", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      eth0: [{ address: "8.8.8.8", family: "IPv4", internal: false } as os.NetworkInterfaceInfo],
    });
    expect(detectLanIp()).toBe("8.8.8.8");
  });

  it("returns 127.0.0.1 when only loopback present", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true } as os.NetworkInterfaceInfo],
    });
    expect(detectLanIp()).toBe("127.0.0.1");
  });
});
```

- [ ] **Step 2: Run test, expect import error**

Run: `cd packages/installer && pnpm test -- lan-ip`

- [ ] **Step 3: Implement detection**

Create `packages/installer/src/lib/tls/lan-ip.ts`:

```typescript
import { networkInterfaces } from "node:os";

function isRfc1918(ip: string): boolean {
  return (
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
  );
}

/**
 * Pick the host's primary LAN IP for inclusion in the self-CA leaf cert SAN.
 * Preference order:
 *   1. First RFC1918 IPv4 found across interfaces — almost always the right
 *      answer for a homelab/internal box (the user reaches this host from
 *      its 192.168.x.y / 10.x.y.z address).
 *   2. First non-loopback IPv4 — for hosts on a public IP.
 *   3. 127.0.0.1 — degenerate fallback (loopback-only). At least the leaf
 *      will still match localhost access.
 */
export function detectLanIp(): string {
  const ifaces = networkInterfaces();
  const candidates: string[] = [];
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const info of list) {
      if (info.family === "IPv4" && !info.internal) {
        candidates.push(info.address);
      }
    }
  }
  const rfc1918 = candidates.find(isRfc1918);
  if (rfc1918) return rfc1918;
  if (candidates.length > 0) return candidates[0];
  return "127.0.0.1";
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/installer && pnpm test -- lan-ip`

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/installer/src/lib/tls/lan-ip.ts packages/installer/src/lib/tls/lan-ip.test.ts
git commit -m "feat(installer): detectLanIp for self-CA leaf cert SAN"
```

---

## Task 2: `lanIp` field in InstallConfig

**Files:**
- Modify: `packages/installer/src/lib/config.ts`
- Modify: `packages/installer/src/lib/config.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/installer/src/lib/config.test.ts`:

```typescript
describe("lanIp config", () => {
  it("defaults to empty (filled by run.ts / headless if needed)", () => {
    expect(emptyConfig().lanIp).toBe("");
  });

  it("AGENTHUB_LAN_IP override sets it", () => {
    const cfg = applyEnvOverrides(emptyConfig(), {
      AGENTHUB_LAN_IP: "10.0.0.5",
    });
    expect(cfg.lanIp).toBe("10.0.0.5");
  });

  it("renderEnv emits AGENTHUB_LAN_IP only when non-empty", () => {
    expect(renderEnv({ ...emptyConfig(), lanIp: "10.0.0.5" })).toContain(
      "AGENTHUB_LAN_IP=10.0.0.5",
    );
    expect(renderEnv({ ...emptyConfig(), lanIp: "" })).not.toContain(
      "AGENTHUB_LAN_IP=",
    );
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

Run: `cd packages/installer && pnpm test -- config.test`

- [ ] **Step 3: Add the field**

Edit `packages/installer/src/lib/config.ts`:

Add to `InstallConfig`:

```typescript
  lanIp: string;
```

Add to `emptyConfig()`:

```typescript
    lanIp: "",
```

In `applyEnvOverrides`:

```typescript
  if (env["AGENTHUB_LAN_IP"]) next.lanIp = env["AGENTHUB_LAN_IP"];
```

In `renderEnv`, add (after the existing TLS-related lines):

```typescript
    ...(cfg.lanIp ? [`AGENTHUB_LAN_IP=${cfg.lanIp}`] : []),
```

- [ ] **Step 4: Run tests, typecheck**

Run: `cd packages/installer && pnpm test && pnpm typecheck`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/installer/src/lib/config.ts packages/installer/src/lib/config.test.ts
git commit -m "feat(installer): lanIp field on InstallConfig"
```

---

## Task 3: Self-CA init script

**Files:**
- Create: `scripts/self-ca-init.sh`

- [ ] **Step 1: Create the script**

Create `scripts/self-ca-init.sh`:

```bash
#!/bin/sh
# Generates a self-signed CA + leaf cert for AgentHub's self-CA TLS mode.
# Idempotent: re-running on a directory that already has ca.crt + leaf.crt
# is a no-op unless REGEN=1.
#
# Inputs (env):
#   DOMAIN   — the install's primary domain (e.g. agenthub.physhlab.com)
#   LAN_IP   — comma-separated list of IPs to include in SAN
#   REGEN    — non-empty forces regeneration (used by reconfigure-tls --regen-cert)
#
# Output: writes to /out (mounted from the traefik-self-ca docker volume):
#   ca.crt + ca.key + leaf.crt + leaf.key + self-ca.yml + last-renewed
#
# The leaf cert covers DOMAIN, *.DOMAIN, and every IP in LAN_IP.
set -eu

: "${DOMAIN:?DOMAIN is required}"
LAN_IP="${LAN_IP:-127.0.0.1}"
OUT="/out"
DAYS_CA=3650         # 10y CA — set-and-forget
DAYS_LEAF=825        # 27mo — within Apple's 825-day max + headroom

apk add --no-cache openssl >/dev/null

if [ -f "$OUT/ca.crt" ] && [ -f "$OUT/leaf.crt" ] && [ -z "${REGEN:-}" ]; then
  echo "[self-ca-init] cert + CA already present; skipping (set REGEN=1 to force)"
  exit 0
fi

# CA — only generate if missing. We never regenerate the root unless the
# volume is wiped.
if [ ! -f "$OUT/ca.crt" ]; then
  echo "[self-ca-init] generating CA root for $DOMAIN"
  openssl genrsa -out "$OUT/ca.key" 4096 2>/dev/null
  openssl req -x509 -new -nodes -key "$OUT/ca.key" -sha256 -days "$DAYS_CA" \
    -out "$OUT/ca.crt" -subj "/CN=AgentHub Self-CA ($DOMAIN)"
fi

# Build the SAN list: domain, *.domain, every comma-separated IP
SAN="DNS:${DOMAIN},DNS:*.${DOMAIN}"
echo "$LAN_IP" | tr ',' '\n' | while IFS= read -r ip; do
  ip=$(echo "$ip" | tr -d ' ')
  if [ -n "$ip" ]; then
    printf "SAN_PART=IP:%s\n" "$ip"
  fi
done > "$OUT/.san-parts"
SAN="$SAN$(awk -F= '{ printf ",%s", $2 }' < "$OUT/.san-parts")"
rm -f "$OUT/.san-parts"

echo "[self-ca-init] generating leaf cert with SAN: $SAN"
openssl req -new -newkey rsa:2048 -nodes -keyout "$OUT/leaf.key" \
  -out "$OUT/leaf.csr" -subj "/CN=$DOMAIN" 2>/dev/null
openssl x509 -req -in "$OUT/leaf.csr" -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" \
  -CAcreateserial -out "$OUT/leaf.crt" -days "$DAYS_LEAF" -sha256 \
  -extfile <(printf "subjectAltName=%s\n" "$SAN") 2>/dev/null

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

date -Iseconds > "$OUT/last-renewed"
echo "[self-ca-init] done"
```

- [ ] **Step 2: Make executable + test syntax**

Run:
```bash
chmod +x scripts/self-ca-init.sh
sh -n scripts/self-ca-init.sh
shellcheck scripts/self-ca-init.sh
```

Expected: no syntax errors, no shellcheck issues.

- [ ] **Step 3: Smoke test in a container**

Run:
```bash
docker run --rm \
  -e DOMAIN=test.example.com \
  -e LAN_IP=192.168.1.5,10.0.0.1 \
  -v "$(pwd)/scripts/self-ca-init.sh:/init.sh:ro" \
  -v /tmp/self-ca-test:/out \
  alpine:3.20 /init.sh

# Inspect outputs
ls -la /tmp/self-ca-test
openssl x509 -in /tmp/self-ca-test/ca.crt -noout -subject
openssl x509 -in /tmp/self-ca-test/leaf.crt -noout -ext subjectAltName
```

Expected: `subject=CN=AgentHub Self-CA (test.example.com)`, leaf SAN includes `DNS:test.example.com, DNS:*.test.example.com, IP:192.168.1.5, IP:10.0.0.1`.

Idempotency check — re-run the same command. Expected: `cert + CA already present; skipping`.

REGEN check — re-run with `-e REGEN=1`. Expected: leaf is regenerated, CA reused.

- [ ] **Step 4: Cleanup**

```bash
rm -rf /tmp/self-ca-test
```

- [ ] **Step 5: Commit**

```bash
git add scripts/self-ca-init.sh
git commit -m "feat(self-ca): init script for CA root + leaf cert generation"
```

---

## Task 4: Self-CA renew sidecar

**Files:**
- Create: `scripts/self-ca-renew.sh`

- [ ] **Step 1: Create the renew script**

Create `scripts/self-ca-renew.sh`:

```bash
#!/bin/sh
# Daily-cron loop that regenerates the self-CA leaf cert when < 30 days
# remaining. CA root is not touched. Runs forever inside a sidecar container.
#
# Inputs (env):
#   DOMAIN   — same as init
#   LAN_IP   — same as init
#
# Triggers /init.sh (mounted alongside) with REGEN=1 when renewal needed.
set -eu

: "${DOMAIN:?DOMAIN is required}"
OUT="/out"
THRESHOLD_DAYS=30

apk add --no-cache openssl coreutils >/dev/null

while true; do
  if [ ! -f "$OUT/leaf.crt" ]; then
    echo "[self-ca-renew] no leaf cert yet — sleeping 1h"
    sleep 3600
    continue
  fi

  # openssl returns NotAfter in epoch via -enddate + date arithmetic
  NOT_AFTER=$(openssl x509 -in "$OUT/leaf.crt" -noout -enddate | sed 's/notAfter=//')
  NOT_AFTER_EPOCH=$(date -d "$NOT_AFTER" +%s)
  NOW_EPOCH=$(date +%s)
  DAYS_LEFT=$(( (NOT_AFTER_EPOCH - NOW_EPOCH) / 86400 ))

  if [ "$DAYS_LEFT" -lt "$THRESHOLD_DAYS" ]; then
    echo "[self-ca-renew] leaf has $DAYS_LEFT days left (< $THRESHOLD_DAYS) — regenerating"
    REGEN=1 sh /init.sh
  else
    echo "[self-ca-renew] leaf has $DAYS_LEFT days left — no action"
  fi

  # Sleep 24h, with a short jitter to avoid a thundering herd if the host
  # ever runs multiple AgentHub installs.
  sleep $(( 86400 + RANDOM % 600 ))
done
```

- [ ] **Step 2: Test syntax**

Run:
```bash
chmod +x scripts/self-ca-renew.sh
sh -n scripts/self-ca-renew.sh
shellcheck scripts/self-ca-renew.sh
```

Expected: no errors. (`$RANDOM` may shellcheck-warn — `# shellcheck disable=SC3028` if needed; alpine's `ash` does support `$RANDOM`.)

- [ ] **Step 3: Smoke test (force-expire scenario)**

Generate a leaf with `DAYS_LEAF=1` first by running init with that override (we'll add a quick env override path inline):

```bash
docker run --rm \
  -e DOMAIN=test.example.com \
  -e LAN_IP=192.168.1.5 \
  -v "$(pwd)/scripts/self-ca-init.sh:/init.sh:ro" \
  -v /tmp/self-ca-renew-test:/out \
  alpine:3.20 sh -c 'sed -i "s/DAYS_LEAF=825/DAYS_LEAF=1/" /init.sh && /init.sh'

# Now run the renew loop with a short cycle for testing
docker run --rm \
  -e DOMAIN=test.example.com \
  -e LAN_IP=192.168.1.5 \
  -v "$(pwd)/scripts/self-ca-init.sh:/init.sh:ro" \
  -v "$(pwd)/scripts/self-ca-renew.sh:/renew.sh:ro" \
  -v /tmp/self-ca-renew-test:/out \
  alpine:3.20 sh -c 'timeout 5 /renew.sh || true'
```

Expected: log line `[self-ca-renew] leaf has 0 days left (< 30) — regenerating`, leaf re-generated.

- [ ] **Step 4: Commit**

```bash
git add scripts/self-ca-renew.sh
git commit -m "feat(self-ca): renew sidecar (daily check, regenerate at <30d)"
```

---

## Task 5: Static `/install/ca` page

**Files:**
- Create: `compose/static/install-ca/index.html`
- Create: `compose/static/install-ca/style.css`
- Create: `compose/static/install-ca/script.js`

- [ ] **Step 1: HTML page with platform tabs**

Create `compose/static/install-ca/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Trust the AgentHub CA</title>
  <link rel="stylesheet" href="/install/ca/style.css">
</head>
<body>
  <main>
    <h1>Trust the AgentHub CA</h1>
    <p class="lead">
      AgentHub generated a private certificate authority for this install.
      Import it on each device that connects to AgentHub from this LAN —
      <strong>once per device</strong>. Then your browser will trust the
      AgentHub HTTPS certificate just like any public site.
    </p>

    <a class="download-btn" href="/.well-known/agenthub-ca.crt" download="agenthub-ca.crt">
      Download CA certificate
    </a>

    <nav class="tabs" id="platform-tabs">
      <button data-tab="macos">macOS</button>
      <button data-tab="ios">iOS</button>
      <button data-tab="android">Android</button>
      <button data-tab="linux">Linux</button>
      <button data-tab="windows">Windows</button>
    </nav>

    <section data-panel="macos">
      <h2>macOS</h2>
      <ol>
        <li>Click the download button above.</li>
        <li>Run this in Terminal:</li>
      </ol>
      <pre><code>sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain ~/Downloads/agenthub-ca.crt</code></pre>
      <button class="copy" data-copy="sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/Downloads/agenthub-ca.crt">Copy</button>
    </section>

    <section data-panel="ios">
      <h2>iOS</h2>
      <ol>
        <li>Tap the download button above on your iOS device.</li>
        <li>Open <strong>Settings → General → VPN &amp; Device Management</strong>.</li>
        <li>Under "Downloaded Profile", tap the AgentHub CA, then tap <strong>Install</strong>.</li>
        <li>Open <strong>Settings → General → About → Certificate Trust Settings</strong>.</li>
        <li>Toggle ON the trust switch next to <strong>AgentHub Self-CA</strong>.</li>
      </ol>
    </section>

    <section data-panel="android">
      <h2>Android</h2>
      <ol>
        <li>Download the certificate to your device.</li>
        <li>Open <strong>Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate</strong>.</li>
        <li>Select the downloaded file and confirm.</li>
      </ol>
      <p class="note">Note: Android distinguishes between user-installed CAs (apps may not trust them) and system CAs. For most browsers, user-installed is sufficient.</p>
    </section>

    <section data-panel="linux">
      <h2>Linux (Debian/Ubuntu)</h2>
      <pre><code>sudo cp ~/Downloads/agenthub-ca.crt /usr/local/share/ca-certificates/agenthub.crt
sudo update-ca-certificates</code></pre>
      <button class="copy" data-copy="sudo cp ~/Downloads/agenthub-ca.crt /usr/local/share/ca-certificates/agenthub.crt && sudo update-ca-certificates">Copy</button>
      <h3>Firefox (separate trust store)</h3>
      <ol>
        <li>Open <strong>about:preferences#privacy</strong>.</li>
        <li>Scroll to <strong>Certificates → View Certificates</strong>.</li>
        <li>Switch to the <strong>Authorities</strong> tab and click <strong>Import…</strong>.</li>
        <li>Select <code>agenthub-ca.crt</code> and check <strong>Trust this CA to identify websites</strong>.</li>
      </ol>
    </section>

    <section data-panel="windows">
      <h2>Windows</h2>
      <ol>
        <li>Download the certificate and double-click it.</li>
        <li>Click <strong>Install Certificate…</strong> → <strong>Local Machine</strong> → <strong>Next</strong>.</li>
        <li>Select <strong>Place all certificates in the following store</strong> → <strong>Browse → Trusted Root Certification Authorities</strong>.</li>
        <li>Click <strong>OK</strong>, <strong>Next</strong>, <strong>Finish</strong>.</li>
      </ol>
    </section>
  </main>
  <script src="/install/ca/script.js"></script>
</body>
</html>
```

- [ ] **Step 2: Stylesheet**

Create `compose/static/install-ca/style.css`:

```css
:root {
  --bg: #0c0e10;
  --fg: #e8e9eb;
  --muted: #9aa0a6;
  --accent: #4ea1ff;
  --code-bg: #1a1d20;
  --border: #2a2d31;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, sans-serif;
}
main {
  max-width: 720px;
  margin: 2rem auto;
  padding: 0 1.25rem;
}
h1 { font-size: 1.75rem; margin: 0 0 .5rem; }
h2 { margin-top: 2rem; }
.lead { color: var(--muted); }
.download-btn {
  display: inline-block;
  background: var(--accent);
  color: #00121f;
  padding: .75rem 1.25rem;
  border-radius: 8px;
  text-decoration: none;
  font-weight: 600;
  margin: 1rem 0 2rem;
}
.tabs {
  display: flex;
  gap: .25rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 1rem;
}
.tabs button {
  background: none;
  border: none;
  color: var(--muted);
  padding: .5rem 1rem;
  cursor: pointer;
  font: inherit;
  border-bottom: 2px solid transparent;
}
.tabs button.active {
  color: var(--fg);
  border-bottom-color: var(--accent);
}
section[data-panel] { display: none; }
section[data-panel].active { display: block; }
pre {
  background: var(--code-bg);
  padding: 1rem;
  border-radius: 6px;
  overflow-x: auto;
}
code { font-family: ui-monospace, monospace; font-size: .9rem; }
.copy {
  background: var(--code-bg);
  border: 1px solid var(--border);
  color: var(--fg);
  padding: .35rem .75rem;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
}
.copy:hover { background: #2a2d31; }
.note {
  font-size: .875rem;
  color: var(--muted);
  border-left: 2px solid var(--border);
  padding-left: .75rem;
  margin-top: 1rem;
}
```

- [ ] **Step 3: Tab + copy script**

Create `compose/static/install-ca/script.js`:

```javascript
(function () {
  const tabs = document.querySelectorAll("#platform-tabs button");
  const panels = document.querySelectorAll("section[data-panel]");

  function show(name) {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    panels.forEach((p) =>
      p.classList.toggle("active", p.dataset.panel === name),
    );
  }

  function detectPlatform() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua)) return "ios";
    if (/Android/.test(ua)) return "android";
    if (/Mac/.test(ua)) return "macos";
    if (/Windows/.test(ua)) return "windows";
    if (/Linux/.test(ua)) return "linux";
    return "macos";
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => show(tab.dataset.tab));
  });

  show(detectPlatform());

  document.querySelectorAll(".copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        const original = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = original;
        }, 1500);
      } catch {
        btn.textContent = "Copy failed — select manually";
      }
    });
  });
})();
```

- [ ] **Step 4: Smoke-test the page locally**

Run:
```bash
cd compose/static/install-ca && python3 -m http.server 8123 &
SERVER_PID=$!
open http://localhost:8123/   # macOS opens in browser
sleep 2
kill $SERVER_PID
```

Expected: page renders, the user's OS tab is pre-selected, copy buttons work. (Tabs other than the auto-selected one work on click.)

- [ ] **Step 5: Commit**

```bash
git add compose/static/install-ca/
git commit -m "feat(self-ca): /install/ca page with platform-aware trust instructions"
```

---

## Task 6: `self-ca` branch in `renderTraefikOverride`

**Files:**
- Modify: `packages/installer/src/lib/tls/render-override.ts`
- Modify: `packages/installer/src/lib/tls/render-override.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/installer/src/lib/tls/render-override.test.ts`:

```typescript
describe("renderTraefikOverride self-ca", () => {
  it("renders init container + renew sidecar + file provider", () => {
    const out = renderTraefikOverride({
      mode: "self-ca",
      domain: "agenthub.physhlab.com",
      tlsEmail: "",
      lanIp: "192.168.4.36",
    });
    const parsed = parseYaml(out!) as Record<string, unknown>;
    const services = parsed.services as Record<string, unknown>;

    expect(services).toHaveProperty("traefik-self-ca-init");
    expect(services).toHaveProperty("traefik-self-ca-renew");
    expect(services).toHaveProperty("traefik");

    const traefik = services["traefik"] as { command: string[] };
    expect(traefik.command).toContain(
      "--providers.file.directory=/etc/traefik/dynamic",
    );
  });

  it("init container receives DOMAIN + LAN_IP env", () => {
    const out = renderTraefikOverride({
      mode: "self-ca",
      domain: "agenthub.physhlab.com",
      tlsEmail: "",
      lanIp: "192.168.4.36,10.0.0.1",
    });
    const parsed = parseYaml(out!) as Record<string, unknown>;
    const init = (parsed.services as Record<string, {
      environment: Record<string, string>;
    }>)["traefik-self-ca-init"];
    expect(init.environment.DOMAIN).toBe("agenthub.physhlab.com");
    expect(init.environment.LAN_IP).toBe("192.168.4.36,10.0.0.1");
  });

  it("adds /install/ca and /.well-known/agenthub-ca.crt routes on HTTP entrypoint", () => {
    const out = renderTraefikOverride({
      mode: "self-ca",
      domain: "agenthub.physhlab.com",
      tlsEmail: "",
      lanIp: "192.168.4.36",
    });
    const parsed = parseYaml(out!) as Record<string, unknown>;
    const traefik = (parsed.services as Record<string, { labels?: string[] }>)[
      "traefik"
    ];
    const labels = traefik.labels ?? [];
    expect(labels.some((l) => l.includes("install-ca"))).toBe(true);
    expect(
      labels.some((l) => l.includes("agenthub-ca")),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests, confirm fail**

Run: `cd packages/installer && pnpm test -- render-override`

- [ ] **Step 3: Add the `lanIp` field to RenderOverrideInput, implement the branch**

Edit `packages/installer/src/lib/tls/render-override.ts`. Update interface:

```typescript
export interface RenderOverrideInput {
  mode: ResolvedTlsMode;
  domain: string;
  tlsEmail: string;
  dnsProvider?: string;
  dnsEnvVars?: Record<string, string>;
  /** Required for mode='self-ca'. Comma-separated list of IPs for SAN. */
  lanIp?: string;
}
```

Add the self-ca branch (insert before the final throw):

```typescript
  if (input.mode === "self-ca") {
    if (!input.lanIp) {
      throw new Error(
        "self-ca TLS mode requires lanIp (host LAN IP for cert SAN).",
      );
    }
    return dumpYaml({
      services: {
        traefik: {
          command: [
            "--providers.file.directory=/etc/traefik/dynamic",
          ],
          volumes: [
            "traefik-self-ca:/etc/traefik/dynamic:ro",
            // Static install-ca page; mounted read-only
            "../compose/static/install-ca:/static/install-ca:ro",
          ],
          depends_on: {
            "traefik-self-ca-init": {
              condition: "service_completed_successfully",
            },
          },
          labels: [
            // CA cert download, served on HTTP :80 to bypass trust loop
            "traefik.http.routers.agenthub-ca.rule=Path(`/.well-known/agenthub-ca.crt`)",
            "traefik.http.routers.agenthub-ca.entrypoints=web",
            "traefik.http.routers.agenthub-ca.middlewares=agenthub-ca-cert",
            "traefik.http.middlewares.agenthub-ca-cert.replacepath.path=/etc/traefik/dynamic/ca.crt",
            // Install instructions page
            "traefik.http.routers.install-ca.rule=PathPrefix(`/install/ca`)",
            "traefik.http.routers.install-ca.entrypoints=web",
          ],
        },
        "traefik-self-ca-init": {
          image: "alpine:3.20",
          restart: "no",
          environment: {
            DOMAIN: input.domain,
            LAN_IP: input.lanIp,
          },
          command: ["/init.sh"],
          volumes: [
            "traefik-self-ca:/out",
            "../scripts/self-ca-init.sh:/init.sh:ro",
          ],
        },
        "traefik-self-ca-renew": {
          image: "alpine:3.20",
          restart: "unless-stopped",
          depends_on: {
            "traefik-self-ca-init": {
              condition: "service_completed_successfully",
            },
          },
          environment: {
            DOMAIN: input.domain,
            LAN_IP: input.lanIp,
          },
          command: ["/renew.sh"],
          volumes: [
            "traefik-self-ca:/out",
            "../scripts/self-ca-init.sh:/init.sh:ro",
            "../scripts/self-ca-renew.sh:/renew.sh:ro",
          ],
        },
      },
      volumes: {
        "traefik-self-ca": {},
      },
    });
  }
```

**Note** about the `agenthub-ca.crt` middleware: Traefik's `replacepath` middleware combined with a `file` provider mount won't actually serve a static file directly through the HTTP entrypoint without a backend service. We'll use a tiny `nginx:alpine` sidecar to serve the static directory cleanly. Update the override:

Replace the `traefik` labels block with the cleaner version using a static-server sidecar:

```typescript
        traefik: {
          command: ["--providers.file.directory=/etc/traefik/dynamic"],
          volumes: ["traefik-self-ca:/etc/traefik/dynamic:ro"],
          depends_on: {
            "traefik-self-ca-init": {
              condition: "service_completed_successfully",
            },
          },
        },
        "agenthub-static": {
          image: "nginx:alpine",
          restart: "unless-stopped",
          volumes: [
            "traefik-self-ca:/usr/share/nginx/html/.well-known:ro",
            "../compose/static/install-ca:/usr/share/nginx/html/install/ca:ro",
          ],
          // Single nginx config: serve /.well-known/agenthub-ca.crt from the
          // CA volume's ca.crt, and /install/ca from the static dir.
          configs: [{ source: "agenthub-static-nginx", target: "/etc/nginx/conf.d/default.conf" }],
          labels: [
            "traefik.enable=true",
            "traefik.http.routers.agenthub-ca.rule=Path(`/.well-known/agenthub-ca.crt`)",
            "traefik.http.routers.agenthub-ca.entrypoints=web",
            "traefik.http.routers.agenthub-ca.service=agenthub-static",
            "traefik.http.routers.install-ca.rule=PathPrefix(`/install/ca`)",
            "traefik.http.routers.install-ca.entrypoints=web",
            "traefik.http.routers.install-ca.service=agenthub-static",
            "traefik.http.services.agenthub-static.loadbalancer.server.port=80",
          ],
        },
```

Add the nginx config block at the bottom of the override:

```typescript
      configs: {
        "agenthub-static-nginx": {
          content: [
            "server {",
            "  listen 80;",
            "  location = /.well-known/agenthub-ca.crt {",
            "    alias /usr/share/nginx/html/.well-known/ca.crt;",
            "    add_header Content-Type application/x-x509-ca-cert;",
            "    add_header Content-Disposition 'attachment; filename=\"agenthub-ca.crt\"';",
            "  }",
            "  location /install/ca/ {",
            "    alias /usr/share/nginx/html/install/ca/;",
            "    index index.html;",
            "  }",
            "  location /install/ca {",
            "    return 301 /install/ca/;",
            "  }",
            "}",
          ].join("\n"),
        },
      },
```

(Adjust the test expectations in Step 1 if the label names differ — the assertions check for `install-ca` and `agenthub-ca` substrings which still match.)

- [ ] **Step 4: Run tests**

Run: `cd packages/installer && pnpm test -- render-override`

Expected: all pass.

- [ ] **Step 5: Run typecheck**

Run: `cd packages/installer && pnpm typecheck`

Expected: clean exit.

- [ ] **Step 6: Commit**

```bash
git add packages/installer/src/lib/tls/render-override.ts packages/installer/src/lib/tls/render-override.test.ts
git commit -m "feat(installer): renderTraefikOverride self-ca branch with nginx static sidecar"
```

---

## Task 7: Wire `lanIp` through install + headless

**Files:**
- Modify: `packages/installer/src/run.ts`
- Modify: `packages/installer/src/headless.ts`

- [ ] **Step 1: Auto-fill `lanIp` in headless when self-ca selected**

Edit `packages/installer/src/headless.ts`. After `applyEnvOverrides`:

```typescript
import { detectLanIp } from "./lib/tls/lan-ip.js";

// ... inside runHeadless, after cfg = applyEnvOverrides(...)
  const resolved = resolveTlsMode(cfg.tlsMode, cfg.domain, process.env);
  if (resolved === "self-ca" && !cfg.lanIp) {
    cfg.lanIp = detectLanIp();
    console.log(`[self-ca] auto-detected LAN IP: ${cfg.lanIp}`);
  }
```

- [ ] **Step 2: Pass lanIp through `writeTraefikOverride`**

Edit `packages/installer/src/run.ts`. In `writeTraefikOverride`, extend the call to `renderTraefikOverride`:

```typescript
  const yaml = renderTraefikOverride({
    mode: resolved,
    domain: cfg.domain,
    tlsEmail: cfg.tlsEmail,
    dnsProvider: cfg.tlsDnsProvider,
    dnsEnvVars,
    lanIp: cfg.lanIp,
  });
```

- [ ] **Step 3: Update `runInstall` to print the install-ca link in self-ca mode**

In `runInstall`, after the success block, add:

```typescript
  // ... after `const url = ...`:
  const resolvedMode = resolveTlsMode(cfg.tlsMode, cfg.domain, process.env);
  const extraLines: string[] = [];
  if (resolvedMode === "self-ca") {
    extraLines.push(
      `Devices on your LAN: open http://${cfg.domain}/install/ca to trust the CA.`,
    );
  }

  return {
    url,
    adminPassword: final.adminPassword,
    infisicalAdminEmail: bootstrap.adminEmail,
    infisicalAdminPassword: bootstrap.adminPassword,
    extraLines,
  };
```

Update the `InstallArtifacts` interface in run.ts to include `extraLines: string[]`.

Update `headless.ts` print loop:

```typescript
    if (art.extraLines && art.extraLines.length > 0) {
      console.log("");
      for (const line of art.extraLines) console.log(line);
    }
```

Update `app.tsx`'s done screen to render `extraLines` similarly.

- [ ] **Step 4: Build, run tests, typecheck**

Run: `cd packages/installer && pnpm build && pnpm test && pnpm typecheck`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/installer/src/run.ts packages/installer/src/headless.ts packages/installer/src/app.tsx
git commit -m "feat(installer): self-ca lanIp wiring + post-install install-ca message"
```

---

## Task 8: TUI `tls-self-ca` step

**Files:**
- Modify: `packages/installer/src/app.tsx`

- [ ] **Step 1: Add the step to the union and route from `tls-strategy`**

Update `Step` union (Plan 2 already added `tls-self-ca` placeholder; if not, add it). In the `tls-strategy` SelectInput's `onSelect`, route self-ca to `tls-self-ca`:

```typescript
              if (tlsMode === "self-ca") {
                setStep("tls-self-ca");
              } else if (tlsMode === "public-alpn" || tlsMode === "dns-01") {
                setStep("tls-email");
              }
```

- [ ] **Step 2: Implement the step**

Add a new block after `tls-dns`:

```tsx
  if (step === "tls-self-ca") {
    return (
      <TlsSelfCaStep
        cfg={cfg}
        onDone={(next) => {
          setCfg(next);
          setStep("admin");
        }}
      />
    );
  }
```

Add the component at the bottom of the file:

```tsx
const TlsSelfCaStep: React.FC<{
  cfg: InstallConfig;
  onDone: (next: InstallConfig) => void;
}> = ({ cfg, onDone }) => {
  const [detected] = useState(() => {
    // Lazy import to avoid pulling node:os into the initial bundle
    const { detectLanIp } = require("./lib/tls/lan-ip.js");
    return detectLanIp();
  });
  const [picking, setPicking] = useState<"choose" | "edit">("choose");
  const [override, setOverride] = useState(detected);

  if (picking === "choose") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Self-CA leaf cert SAN</Text>
        <Text>Detected LAN IP: <Text color="cyan">{detected}</Text></Text>
        <Text>
          The leaf cert will cover{" "}
          <Text color="cyan">{cfg.domain}</Text>,{" "}
          <Text color="cyan">*.{cfg.domain}</Text>, and the LAN IP above —
          so direct-IP access works without a hostname mismatch.
        </Text>
        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: `Use detected IP (${detected})`, value: "use" },
              { label: "Enter different IP / list (comma-separated)", value: "edit" },
            ]}
            onSelect={(item) => {
              if (item.value === "use") {
                onDone({ ...cfg, lanIp: detected });
              } else {
                setPicking("edit");
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text>LAN IPs (comma-separated, e.g. 192.168.4.36,10.0.0.1):</Text>
      <Box>
        <Text color="cyan">{"> "}</Text>
        <TextInput
          value={override}
          onChange={setOverride}
          onSubmit={(v) => {
            onDone({ ...cfg, lanIp: v.trim() || detected });
          }}
        />
      </Box>
    </Box>
  );
};
```

- [ ] **Step 3: Smoke-test the TUI**

Run: `cd packages/installer && pnpm build && pnpm dev`

Walk through: `domain=test.local → tls-strategy=Self-signed CA → tls-self-ca` shows detected LAN IP. Confirm "Use detected IP" submits and goes to `admin`. (Don't actually finish the install — Ctrl-C.)

- [ ] **Step 4: Commit**

```bash
git add packages/installer/src/app.tsx
git commit -m "feat(installer): TUI tls-self-ca step with LAN IP auto-detect"
```

---

## Task 9: Update `.env.example` and install docs

**Files:**
- Modify: `compose/.env.example`
- Modify: `docs/install/agents.md`
- Modify: `docs/install/humans.md`
- Create: `docs/install/tls-modes.md`

- [ ] **Step 1: .env.example**

Edit `compose/.env.example`. After the DNS-01 block, add:

```
# Self-CA mode: comma-separated list of IPs to include in the leaf cert SAN.
# Defaults to the host's primary RFC1918 LAN IP. Used by the self-ca-init
# container; doesn't affect non-self-ca modes.
# AGENTHUB_LAN_IP=
```

- [ ] **Step 2: agents.md self-ca example**

Edit `docs/install/agents.md`. Add:

```markdown
### Internal-only with self-CA (no DNS / internet needed)

```bash
curl -fsSL .../quick-install.sh \
  | AGENTHUB_AUTO_INSTALL=true \
    AGENTHUB_DOMAIN=agenthub.local \
    AGENTHUB_TLS_MODE=self-ca \
    AGENTHUB_ADMIN_PASSWORD=<pw> \
    bash -s -- --non-interactive
```

After install, open `http://<domain>/install/ca` from each device on the LAN
to import the CA cert. Then HTTPS to AgentHub will be trusted.
```

- [ ] **Step 3: humans.md self-CA section**

Add to `docs/install/humans.md`:

```markdown
### Self-signed CA mode

The TUI auto-detects your host's LAN IP and bakes it into the cert's SAN
list, so `https://192.168.x.y` works without a hostname mismatch alongside
your domain. After install, visit `http://<domain>/install/ca` from each
device on the LAN to import the CA cert (one-time per device).

The leaf cert is renewed automatically when it has < 30 days remaining;
you'll never need to think about it. The CA root is valid for 10 years.
```

- [ ] **Step 4: Create tls-modes.md reference doc**

Create `docs/install/tls-modes.md`:

```markdown
# TLS modes

AgentHub supports four TLS strategies. Pick based on whether your install is
publicly reachable on `:443` and whether you can give it a DNS provider's
API token.

| Mode | When to use | Requires |
|---|---|---|
| `auto` (default) | Most installs — let the installer decide | nothing |
| `public-alpn` | Host is on the public internet, port 443 reachable | `AGENTHUB_TLS_EMAIL` |
| `dns-01` | Internal-only, you have a DNS provider API token | `AGENTHUB_TLS_EMAIL`, `AGENTHUB_TLS_DNS_PROVIDER`, provider token |
| `self-ca` | Fully internal, no DNS API, no internet | nothing — but each device imports the CA once |

## auto

Inference rules:

- `DOMAIN=localhost` → no cert resolver; Traefik's default cert is served.
- `AGENTHUB_TLS_DNS_PROVIDER` is set → `dns-01`
- otherwise → `public-alpn`

## public-alpn

Let's Encrypt via TLS-ALPN-01. Traefik solves the challenge by accepting an
inbound :443 connection from LE's servers and presenting a special cert.

**Required:** `AGENTHUB_TLS_EMAIL=ops@example.com`

**Common failures:**
- ISP blocks inbound :443 → use `dns-01` or `self-ca` instead
- DNS A record missing or wrong → check `dig <domain>`
- Multiple boxes share the same hostname → pick one to certify

## dns-01

Let's Encrypt via DNS-01. Traefik (via lego) provisions a TXT record on
your DNS zone, LE verifies it, you get a cert. Works on internal-only hosts.

**Required:**
- `AGENTHUB_TLS_EMAIL`
- `AGENTHUB_TLS_DNS_PROVIDER` — lego provider name (`cloudflare`, `route53`,
  `digitalocean`, `hetzner`, `gandi`, `linode`, …)
- Provider-specific token:
  - Cloudflare: `AGENTHUB_CLOUDFLARE_API_TOKEN` (or `CF_DNS_API_TOKEN`)
  - Others: pre-export the lego-native env vars (see lego docs)

**Common failures:**
- Wrong API token → pre-flight catches this for Cloudflare
- Token lacks the right zone → likewise
- Propagation timeout → most often resolved by re-running the install

## self-ca

A private CA generated on the host. Issues a leaf cert for `<domain>`,
`*.<domain>`, and your LAN IP. Each device that connects to AgentHub
imports the CA once via `http://<domain>/install/ca`.

**Required:** nothing beyond `AGENTHUB_TLS_MODE=self-ca`. Optionally:
- `AGENTHUB_LAN_IP=…` — override auto-detected LAN IP

The CA is valid for 10 years; the leaf is valid for 27 months and
auto-renewed when it has < 30 days remaining.
```

- [ ] **Step 5: Commit**

```bash
git add compose/.env.example docs/install/agents.md docs/install/humans.md docs/install/tls-modes.md
git commit -m "docs(install): self-ca mode + new tls-modes.md reference"
```

---

## Task 10: End-to-end self-CA verification

- [ ] **Step 1: Headless self-CA install**

On a fresh internal-only Proxmox VM:

```bash
curl -fsSL .../quick-install.sh \
  | AGENTHUB_AUTO_INSTALL=true \
    AGENTHUB_DOMAIN=test-selfca.lan \
    AGENTHUB_TLS_MODE=self-ca \
    AGENTHUB_ADMIN_PASSWORD=test \
    bash -s -- --non-interactive
```

Expected:
- Install completes; `[self-ca] auto-detected LAN IP: <ip>` appears in logs
- Final stdout includes `Devices on your LAN: open http://test-selfca.lan/install/ca to trust the CA.`
- `traefik-self-ca-init` container ran to completion
- `traefik-self-ca-renew` container is running (`docker ps | grep renew`)
- `openssl s_client -connect <lan-ip>:443 -servername test-selfca.lan` shows issuer = `AgentHub Self-CA (test-selfca.lan)`

- [ ] **Step 2: CA distribution sanity**

From the host or a client on the same LAN:

```bash
curl -v http://<lan-ip>/.well-known/agenthub-ca.crt -o ca.crt
file ca.crt   # should report PEM certificate
```

Expected: download succeeds, `Content-Type: application/x-x509-ca-cert`.

Open `http://<lan-ip>/install/ca` in a browser. Expected: page renders with the user's OS tab pre-selected.

- [ ] **Step 3: Trust + browse**

On a Mac client:

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain ca.crt
```

Open `https://test-selfca.lan/`. Expected: green padlock, no warnings.

Try direct IP: `https://<lan-ip>/`. Expected: also green padlock (LAN IP is in the SAN).

Try a wildcard: `https://anything.test-selfca.lan/`. Expected: green padlock (wildcard SAN).

- [ ] **Step 4: Renewal smoke test**

Force the renew sidecar to run with a short cert:

```bash
docker compose exec traefik-self-ca-init sh -c '
  sed -i "s/DAYS_LEAF=825/DAYS_LEAF=29/" /init.sh
  REGEN=1 /init.sh
'
# Wait up to 24h, or send SIGHUP, or restart the renew sidecar to trigger immediate check
docker compose restart traefik-self-ca-renew
sleep 10
docker compose logs traefik-self-ca-renew | tail -20
```

Expected: `[self-ca-renew] leaf has 29 days left (< 30) — regenerating`.

- [ ] **Step 5: Tag completion**

```bash
git tag -a tls-plan-3-complete -m "TLS Plan 3 (self-ca + CA distribution) verified end-to-end"
```

---

## Self-Review

**Spec coverage:**
- ✅ Self-CA init script (Task 3)
- ✅ Self-CA renew sidecar (Task 4)
- ✅ Install-CA page with platform tabs (Task 5)
- ✅ Render-override self-ca branch + nginx static sidecar (Task 6)
- ✅ LAN IP detection (Task 1) + config field (Task 2)
- ✅ TUI tls-self-ca step (Task 8)
- ✅ HTTP routes for `/.well-known/agenthub-ca.crt` and `/install/ca` (Task 6)
- ✅ docs/install/tls-modes.md reference (Task 9)
- ❌ Reconfigure CLI — Plan 4
- ❌ TLS health surface — Plan 5

**Placeholder scan:** No "TODO"/"TBD". Each script and component is fully specified.

**Type consistency:** `lanIp` (string, comma-separated) used consistently across config / render-override / scripts. `detectLanIp()` returns a single IP; user can override to a list via env or TUI edit field.
