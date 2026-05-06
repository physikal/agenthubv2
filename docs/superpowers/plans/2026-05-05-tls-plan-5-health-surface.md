# TLS Plan 5: TLS Health Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Depends on:** Plans 1, 2, 3, 4 merged.

**Goal:** Make TLS health a first-class signal across `/api/health`, the admin UI Settings page, the top-of-app banner, and `agenthub status` — so renewal failures, near-expiry certs, and pre-fix `TRAEFIK DEFAULT CERT` installs all surface where operators already look.

**Architecture:** A single `services/tls/health.ts` runs an `openssl s_client` probe against `127.0.0.1:443` from inside the agenthub-server container, parses the cert, classifies it, caches for 60s. Three surfaces consume this: the existing `/api/health` route adds a `tls` field; a new `TlsCard` on the Settings page reads it on mount and provides Reconfigure/Renew/Test buttons (the modal from Plan 4); a `MigrationBanner` shows at the top of the layout when the cert is `TRAEFIK DEFAULT CERT`; the `agenthub status` shell command gains one extra line.

**Tech Stack:** TypeScript ESM, Hono (server), React (web), Bash (scripts/agenthub).

**Spec reference:** Section "TLS health surface" and "Migration nudge for pre-fix installs" in `2026-05-05-flexible-tls-install-design.md`.

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `packages/server/src/services/tls/health.ts` | new | One-shot TLS health probe with 60s cache |
| `packages/server/src/services/tls/health.test.ts` | new | Tests using fixture openssl outputs |
| `packages/server/src/routes/health.ts` | modify | Adds `tls` field to response |
| `packages/server/src/routes/admin.ts` | modify | Replaces the `/tls/test` stub from Plan 4 with a real implementation |
| `packages/web/src/components/tls/TlsCard.tsx` | new | Settings page card with status + actions |
| `packages/web/src/components/tls/MigrationBanner.tsx` | new | Top-of-app one-time banner |
| `packages/web/src/pages/Settings.tsx` | modify | Mounts TlsCard |
| `packages/web/src/Layout.tsx` (or equivalent) | modify | Mounts MigrationBanner |
| `scripts/agenthub` | modify | `status` verb gains TLS line |
| `docs/troubleshooting.md` | modify | Adds TLS-section reference |

---

## Task 1: TLS health probe

**Files:**
- Create: `packages/server/src/services/tls/health.ts`
- Create: `packages/server/src/services/tls/health.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/server/src/services/tls/health.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { classifyCert, type ParsedTlsCert } from "./health.js";

const now = new Date("2026-05-05T00:00:00Z");

const traefikDefault: ParsedTlsCert = {
  subjectCN: "TRAEFIK DEFAULT CERT",
  issuerCN: "TRAEFIK DEFAULT CERT",
  notBefore: new Date("2026-04-25"),
  notAfter: new Date("2027-04-25"),
};
const validLE: ParsedTlsCert = {
  subjectCN: "agenthub.physhlab.com",
  issuerCN: "R10",
  issuerO: "Let's Encrypt",
  notBefore: new Date("2026-03-01"),
  notAfter: new Date("2026-06-01"),
};
const expiringSoon: ParsedTlsCert = {
  ...validLE,
  notAfter: new Date("2026-05-15"), // 10 days away
};
const expired: ParsedTlsCert = {
  ...validLE,
  notAfter: new Date("2026-04-01"),
};
const selfCa: ParsedTlsCert = {
  subjectCN: "agenthub.local",
  issuerCN: "AgentHub Self-CA (agenthub.local)",
  notBefore: new Date("2026-04-01"),
  notAfter: new Date("2028-08-01"),
};

describe("classifyCert", () => {
  it("flags TRAEFIK DEFAULT CERT as default-fallback", () => {
    const r = classifyCert(traefikDefault, "agenthub.physhlab.com", now);
    expect(r.resolver).toBe("default-fallback");
    expect(r.ok).toBe(false);
    expect(r.warnings).toContain("serving Traefik default cert — TLS misconfigured");
  });

  it("identifies Let's Encrypt by issuer", () => {
    const r = classifyCert(validLE, "agenthub.physhlab.com", now);
    expect(r.resolver).toBe("public-alpn");
    expect(r.issuer).toBe("Let's Encrypt");
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.daysToExpiry).toBe(27);
  });

  it("identifies self-CA by issuer prefix", () => {
    const r = classifyCert(selfCa, "agenthub.local", now);
    expect(r.resolver).toBe("self-ca");
    expect(r.issuer).toMatch(/AgentHub Self-CA/);
    expect(r.ok).toBe(true);
  });

  it("warns when expiring < 14 days", () => {
    const r = classifyCert(expiringSoon, "agenthub.physhlab.com", now);
    expect(r.ok).toBe(true);
    expect(r.warnings).toContain("expires in 10 days");
  });

  it("flags expired cert", () => {
    const r = classifyCert(expired, "agenthub.physhlab.com", now);
    expect(r.ok).toBe(false);
    expect(r.warnings.some((w) => /expired/i.test(w))).toBe(true);
  });
});
```

(Tests for the live-probe `getTlsHealth()` are limited because they depend on Traefik running; we'll cover the probe via integration tests in Task 6.)

- [ ] **Step 2: Run test, expect import error**

Run: `cd packages/server && pnpm test -- tls/health`

- [ ] **Step 3: Implement classification + probe**

Create `packages/server/src/services/tls/health.ts`:

```typescript
import { execFileSync } from "node:child_process";

export interface ParsedTlsCert {
  subjectCN: string;
  issuerCN: string;
  issuerO?: string;
  notBefore: Date;
  notAfter: Date;
}

export interface TlsHealth {
  ok: boolean;
  domain: string;
  resolver: "public-alpn" | "dns-01" | "self-ca" | "default-fallback" | "unknown";
  issuer: string;
  notBefore: string;
  notAfter: string;
  daysToExpiry: number;
  warnings: string[];
}

export function classifyCert(
  cert: ParsedTlsCert,
  domain: string,
  now: Date,
): TlsHealth {
  const warnings: string[] = [];
  const msPerDay = 86_400_000;
  const daysToExpiry = Math.floor(
    (cert.notAfter.getTime() - now.getTime()) / msPerDay,
  );

  let resolver: TlsHealth["resolver"];
  let issuer: string;

  if (cert.issuerCN === "TRAEFIK DEFAULT CERT") {
    resolver = "default-fallback";
    issuer = "Traefik default (self-signed)";
    warnings.push("serving Traefik default cert — TLS misconfigured");
  } else if (cert.issuerO === "Let's Encrypt") {
    resolver = "public-alpn"; // We can't tell ALPN vs DNS-01 from the cert alone — both yield LE
    issuer = "Let's Encrypt";
  } else if (cert.issuerCN.startsWith("AgentHub Self-CA")) {
    resolver = "self-ca";
    issuer = cert.issuerCN;
  } else {
    resolver = "unknown";
    issuer = cert.issuerO ?? cert.issuerCN;
  }

  if (daysToExpiry < 0) {
    warnings.push(`cert expired ${-daysToExpiry} days ago`);
  } else if (daysToExpiry < 14) {
    warnings.push(`expires in ${daysToExpiry} days`);
  }

  // SAN match — basic check: subject CN contains the domain
  if (
    resolver !== "default-fallback" &&
    cert.subjectCN !== domain &&
    !cert.subjectCN.startsWith("*.")
  ) {
    warnings.push(`cert subject ${cert.subjectCN} doesn't match ${domain}`);
  }

  const ok = resolver !== "default-fallback" && daysToExpiry >= 0;

  return {
    ok,
    domain,
    resolver,
    issuer,
    notBefore: cert.notBefore.toISOString(),
    notAfter: cert.notAfter.toISOString(),
    daysToExpiry,
    warnings,
  };
}

let cache: { at: number; result: TlsHealth | null } = { at: 0, result: null };

/**
 * Probe the live serving cert via openssl s_client and classify it. Cached
 * for 60s to avoid hammering Traefik on health-check loops.
 */
export function getTlsHealth(domain: string, force = false): TlsHealth {
  if (!force && cache.result && Date.now() - cache.at < 60_000) {
    return cache.result;
  }
  let cert: ParsedTlsCert;
  try {
    cert = probe(domain);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "probe failed";
    const result: TlsHealth = {
      ok: false,
      domain,
      resolver: "unknown",
      issuer: "(probe failed)",
      notBefore: new Date(0).toISOString(),
      notAfter: new Date(0).toISOString(),
      daysToExpiry: 0,
      warnings: [msg],
    };
    cache = { at: Date.now(), result };
    return result;
  }
  const result = classifyCert(cert, domain, new Date());
  cache = { at: Date.now(), result };
  return result;
}

function probe(domain: string): ParsedTlsCert {
  const stdout = execFileSync(
    "openssl",
    [
      "s_client",
      "-connect",
      "127.0.0.1:443",
      "-servername",
      domain,
      "-showcerts",
    ],
    { input: "", stdio: ["pipe", "pipe", "ignore"], timeout: 8_000 },
  ).toString();
  return parseOpenssl(stdout);
}

function parseOpenssl(stdout: string): ParsedTlsCert {
  const subject = stdout.match(/^subject=(.+)$/m)?.[1];
  const issuer = stdout.match(/^issuer=(.+)$/m)?.[1];
  const nb = stdout.match(/^notBefore=(.+)$/m)?.[1];
  const na = stdout.match(/^notAfter=(.+)$/m)?.[1];
  if (!subject || !issuer || !nb || !na) {
    throw new Error("probe: missing required fields in openssl output");
  }
  const pickField = (dn: string, key: string): string | undefined =>
    dn.match(new RegExp(`(?:^|,\\s*)${key}=([^,]+)`))?.[1].trim();
  return {
    subjectCN: pickField(subject, "CN") ?? "",
    issuerCN: pickField(issuer, "CN") ?? "",
    ...(pickField(issuer, "O") !== undefined ? { issuerO: pickField(issuer, "O") } : {}),
    notBefore: new Date(nb),
    notAfter: new Date(na),
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/server && pnpm test -- tls/health`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/tls/health.ts packages/server/src/services/tls/health.test.ts
git commit -m "feat(server): tls/health probe + classification"
```

---

## Task 2: Extend `/api/health` and replace `/tls/test` stub

**Files:**
- Modify: `packages/server/src/routes/health.ts`
- Modify: `packages/server/src/routes/admin.ts`

- [ ] **Step 1: Read existing health route**

Run: `cat packages/server/src/routes/health.ts`

Note the current shape of the response.

- [ ] **Step 2: Add `tls` field to /api/health**

Edit `packages/server/src/routes/health.ts`. Wrap the existing return:

```typescript
import { getTlsHealth } from "../services/tls/health.js";

// inside the handler:
  const domain = process.env.AGENTHUB_DOMAIN ?? process.env.DOMAIN ?? "localhost";
  let tls: ReturnType<typeof getTlsHealth> | null = null;
  if (domain !== "localhost") {
    try {
      tls = getTlsHealth(domain);
    } catch {
      // Probe failure is reflected via tls.warnings; never crash the health
      // endpoint itself
    }
  }
  return c.json({
    ok: true,
    // ... existing fields ...
    ...(tls ? { tls } : {}),
  });
```

- [ ] **Step 3: Replace the `/tls/test` stub with a real implementation**

Edit `packages/server/src/routes/admin.ts`. Replace the Plan 4 stub for `/tls/test` with:

```typescript
admin.post("/tls/test", async (c) => {
  const domain = process.env.AGENTHUB_DOMAIN ?? process.env.DOMAIN;
  if (!domain || domain === "localhost") {
    return c.json({
      ok: false,
      reason: "no domain to test (localhost install or DOMAIN unset)",
    });
  }
  const result = getTlsHealth(domain, /* force */ true);
  return c.json(result);
});
```

Add the import:

```typescript
import { getTlsHealth } from "../services/tls/health.js";
```

- [ ] **Step 4: Run server tests + typecheck**

Run: `cd packages/server && pnpm test && pnpm typecheck`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/health.ts packages/server/src/routes/admin.ts
git commit -m "feat(server): tls field on /api/health, real /tls/test endpoint"
```

---

## Task 3: TlsCard component

**Files:**
- Create: `packages/web/src/components/tls/TlsCard.tsx`
- Modify: `packages/web/src/lib/api.ts` (add a `getHealth()` accessor for `tls`)

- [ ] **Step 1: Add `getHealth()` API helper**

Edit `packages/web/src/lib/api.ts`:

```typescript
export interface TlsHealthResponse {
  ok: boolean;
  domain: string;
  resolver: "public-alpn" | "dns-01" | "self-ca" | "default-fallback" | "unknown";
  issuer: string;
  notBefore: string;
  notAfter: string;
  daysToExpiry: number;
  warnings: string[];
}

export interface HealthResponse {
  ok: boolean;
  tls?: TlsHealthResponse;
}

export async function getHealth(): Promise<HealthResponse> {
  const res = await fetch("/api/health");
  return res.json();
}
```

- [ ] **Step 2: Implement TlsCard**

Create `packages/web/src/components/tls/TlsCard.tsx`:

```tsx
import React, { useEffect, useState } from "react";
import { getHealth, tlsTest, type TlsHealthResponse } from "../../lib/api.js";
import { ReconfigureTlsModal } from "./ReconfigureTlsModal.js";

function statusIcon(tls: TlsHealthResponse): "ok" | "warn" | "error" {
  if (!tls.ok) return "error";
  if (tls.warnings.length > 0) return "warn";
  return "ok";
}

export const TlsCard: React.FC = () => {
  const [tls, setTls] = useState<TlsHealthResponse | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TlsHealthResponse | null>(null);

  async function refresh(): Promise<void> {
    const h = await getHealth();
    setTls(h.tls ?? null);
  }

  useEffect(() => {
    void refresh();
  }, []);

  if (!tls) {
    return (
      <div className="card">
        <h3>TLS</h3>
        <p className="muted">No TLS data (localhost install or probe pending).</p>
      </div>
    );
  }

  const icon = statusIcon(tls);

  async function runTest(): Promise<void> {
    setTesting(true);
    try {
      const r = await tlsTest();
      setTestResult(r as TlsHealthResponse);
    } finally {
      setTesting(false);
    }
  }

  async function forceRenew(): Promise<void> {
    // Plan 4's /tls/renew endpoint streams SSE; for the card we just
    // POST and refresh on completion (modal-less for the renew action)
    const res = await fetch("/api/admin/tls/renew", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: tls!.resolver }),
    });
    if (res.ok) await refresh();
  }

  return (
    <div className="card">
      <h3>TLS</h3>

      <div className={`status status-${icon}`}>
        {icon === "ok" ? "✓" : icon === "warn" ? "⚠" : "✗"}{" "}
        <strong>{tls.issuer}</strong>{" "}
        <span className="muted">({tls.resolver})</span>
      </div>

      <p>
        Valid for <code>{tls.domain}</code>
        <br />
        {tls.daysToExpiry >= 0
          ? `Expires in ${tls.daysToExpiry} day${tls.daysToExpiry === 1 ? "" : "s"}`
          : `Expired ${-tls.daysToExpiry} days ago`}
      </p>

      {tls.warnings.length > 0 && (
        <ul className="warnings">
          {tls.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      <div className="actions">
        <button onClick={() => setShowModal(true)}>Reconfigure TLS</button>
        <button onClick={forceRenew}>Force renew</button>
        <button onClick={runTest} disabled={testing}>
          {testing ? "Testing…" : "Test"}
        </button>
      </div>

      {testResult && (
        <div className="test-result">
          <h4>Test result</h4>
          <pre>{JSON.stringify(testResult, null, 2)}</pre>
        </div>
      )}

      {showModal && (
        <ReconfigureTlsModal
          initialDomain={tls.domain}
          defaultLanIp=""
          onClose={() => {
            setShowModal(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
};
```

- [ ] **Step 3: Mount on Settings page**

Edit `packages/web/src/pages/Settings.tsx`. Add:

```tsx
import { TlsCard } from "../components/tls/TlsCard.js";

// in the render, alongside the existing Version card:
<TlsCard />
```

- [ ] **Step 4: Build the web bundle**

Run: `cd packages/web && pnpm build`

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tls/TlsCard.tsx packages/web/src/pages/Settings.tsx packages/web/src/lib/api.ts
git commit -m "feat(web): TLS card on Settings page"
```

---

## Task 4: MigrationBanner

**Files:**
- Create: `packages/web/src/components/tls/MigrationBanner.tsx`
- Modify: `packages/web/src/Layout.tsx` (or whichever component wraps the app)

- [ ] **Step 1: Implement the banner**

Create `packages/web/src/components/tls/MigrationBanner.tsx`:

```tsx
import React, { useEffect, useState } from "react";
import { getHealth } from "../../lib/api.js";
import { ReconfigureTlsModal } from "./ReconfigureTlsModal.js";

const DISMISS_KEY = "agenthub:tls-migration-banner-dismissed-v1";

export const MigrationBanner: React.FC = () => {
  const [show, setShow] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [domain, setDomain] = useState("");

  useEffect(() => {
    if (localStorage.getItem(DISMISS_KEY) === "true") return;
    void (async () => {
      const h = await getHealth();
      if (h.tls && h.tls.resolver === "default-fallback") {
        setShow(true);
        setDomain(h.tls.domain);
      }
    })();
  }, []);

  if (!show) return null;

  function dismiss(): void {
    localStorage.setItem(DISMISS_KEY, "true");
    setShow(false);
  }

  return (
    <div className="migration-banner">
      <span>
        ⚠ TLS misconfigured — your site is serving Traefik's default
        self-signed cert.
      </span>
      <button onClick={() => setShowModal(true)}>Fix now</button>
      <button onClick={dismiss}>Dismiss</button>

      {showModal && (
        <ReconfigureTlsModal
          initialDomain={domain}
          defaultLanIp=""
          onClose={() => {
            setShowModal(false);
            // Re-probe; if it's healthy now, the banner stays hidden
            void getHealth().then((h) => {
              if (h.tls && h.tls.resolver !== "default-fallback") {
                setShow(false);
              }
            });
          }}
        />
      )}
    </div>
  );
};
```

- [ ] **Step 2: Mount in Layout**

Edit the top-level Layout component. Find where the main `<header>` or page-frame lives and add the banner right above the page content:

```tsx
import { MigrationBanner } from "./components/tls/MigrationBanner.js";

// inside the layout:
<MigrationBanner />
{/* existing main content */}
```

- [ ] **Step 3: Add minimal styles**

Add to global stylesheet:

```css
.migration-banner {
  background: #4a1a1a;
  color: #ffd9d9;
  padding: 0.75rem 1.25rem;
  display: flex;
  align-items: center;
  gap: 1rem;
  border-bottom: 1px solid #6a2a2a;
  font-size: 0.875rem;
}
.migration-banner button {
  background: transparent;
  border: 1px solid currentColor;
  color: inherit;
  padding: 0.25rem 0.75rem;
  border-radius: 4px;
  cursor: pointer;
}
```

- [ ] **Step 4: Build + commit**

Run: `cd packages/web && pnpm build`

Then:

```bash
git add packages/web/src/components/tls/MigrationBanner.tsx packages/web/src/Layout.tsx packages/web/src/index.css
git commit -m "feat(web): migration banner for default-fallback TLS state"
```

---

## Task 5: `agenthub status` TLS line

**Files:**
- Modify: `scripts/agenthub`

- [ ] **Step 1: Add a TLS line to the status output**

Edit `scripts/agenthub`'s `status` action. After printing the existing service status:

```bash
# TLS status — fetched from /api/health
TLS_JSON=$(curl -ksf -m 5 "https://${DOMAIN:-localhost}/api/health" 2>/dev/null || \
           curl -sf -m 5 "http://localhost:3000/api/health" 2>/dev/null || \
           echo '{}')

if echo "$TLS_JSON" | grep -q '"tls":'; then
  TLS_OK=$(echo "$TLS_JSON" | grep -oE '"ok":(true|false)' | head -1 | cut -d: -f2)
  TLS_RESOLVER=$(echo "$TLS_JSON" | grep -oE '"resolver":"[^"]+"' | head -1 | cut -d'"' -f4)
  TLS_DAYS=$(echo "$TLS_JSON" | grep -oE '"daysToExpiry":-?[0-9]+' | head -1 | cut -d: -f2)
  if [ "$TLS_OK" = "true" ]; then
    if [ "${TLS_DAYS:-100}" -lt 14 ]; then
      printf "TLS           %-10s %s\n" "WARN" "$TLS_RESOLVER — ${TLS_DAYS}d remaining (expiring soon)"
    else
      printf "TLS           %-10s %s\n" "ok" "$TLS_RESOLVER — ${TLS_DAYS}d remaining"
    fi
  else
    if [ "$TLS_RESOLVER" = "default-fallback" ]; then
      printf "TLS           %-10s %s\n" "WARN" "serving Traefik default cert — run 'agenthub reconfigure-tls'"
    else
      printf "TLS           %-10s %s\n" "ERROR" "$TLS_RESOLVER ($TLS_DAYS days remaining)"
    fi
  fi
fi
```

- [ ] **Step 2: Smoke test**

On a real install:

```bash
agenthub status
```

Expected: existing service-status output, then a new `TLS …` line reflecting the current state.

- [ ] **Step 3: Commit**

```bash
git add scripts/agenthub
git commit -m "feat(cli): TLS status line in agenthub status output"
```

---

## Task 6: End-to-end health-surface verification

- [ ] **Step 1: Verify `/api/health` on each TLS mode**

On three test boxes (one per mode):

```bash
curl -k https://<domain>/api/health | jq .tls
```

Expected outputs:

- public-alpn: `{ ok: true, resolver: "public-alpn", issuer: "Let's Encrypt", … }`
- self-ca: `{ ok: true, resolver: "self-ca", issuer: "AgentHub Self-CA (…)", … }`
- pre-fix install: `{ ok: false, resolver: "default-fallback", warnings: ["serving Traefik default cert — TLS misconfigured"] }`

- [ ] **Step 2: Migration banner UX check**

Manually break TLS on a test install (e.g. `docker compose down traefik` then `docker compose up -d traefik` with the override removed). Open the admin UI. Expected: red banner appears at top with [Fix now] / [Dismiss].

- [ ] **Step 3: TlsCard on Settings**

Open Settings page on a healthy install. Expected: TLS card shows green check + issuer + days-remaining. [Reconfigure TLS] opens the modal. [Test] runs a probe and shows the result inline.

- [ ] **Step 4: `agenthub status` in all three states**

```bash
# Healthy
agenthub status   # expect: TLS  ok  ...

# < 14 days (force by editing DAYS_LEAF in init script for self-ca)
agenthub status   # expect: TLS  WARN  ...

# Default-fallback (break TLS)
agenthub status   # expect: TLS  WARN  serving Traefik default cert ...
```

- [ ] **Step 5: Tag completion**

```bash
git tag -a tls-plan-5-complete -m "TLS Plan 5 (health surface + migration banner) verified end-to-end"
```

---

## Task 7: Final docs sweep

**Files:**
- Modify: `docs/troubleshooting.md`
- Modify: Obsidian `Services/AgentHub v2/Install & Operations.md`
- Modify: Obsidian `Services/AgentHub v2/Gotchas.md`

- [ ] **Step 1: Add TLS section to troubleshooting.md**

Edit `docs/troubleshooting.md`. Add:

```markdown
## TLS issues

### "Your connection isn't private" / browser shows red padlock

Run `agenthub status`. If you see `TLS WARN serving Traefik default cert`,
your install fell through to Traefik's default cert. Fix:

```bash
agenthub reconfigure-tls
```

Or from the admin UI, click [Fix now] in the migration banner.

### Cert is valid but expiring soon

Same UI: Settings → TLS card → [Force renew]. Or from the host:

```bash
agenthub reconfigure-tls --regen-cert   # self-ca only
# (LE renews automatically on Traefik restart)
```

### Cloudflare DNS-01 failing

Most often: API token doesn't have access to the right zone. Verify:

```bash
curl -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=<your-zone>"
```

Should return your zone in `result`. If not, re-create the token with
`Zone:Read` + `DNS:Edit` permissions on the right zone.

### Self-CA leaf doesn't match my LAN IP

You moved the box, or the auto-detected IP was wrong. Reconfigure with the
right IP:

```bash
AGENTHUB_TLS_MODE=self-ca \
AGENTHUB_LAN_IP=<correct-ip> \
agenthub reconfigure-tls --regen-cert --non-interactive
```
```

- [ ] **Step 2: Update Obsidian docs**

Edit `/Users/joshowen/Library/CloudStorage/ProtonDrive-joshowen@protonmail.com-folder/Documentation/Obsidian/Knowledge/Services/AgentHub v2/Install & Operations.md`. Add a "TLS modes" section linking to `docs/install/tls-modes.md` (in repo) and a brief operator-side summary.

Edit `Gotchas.md`. Add a TLS gotcha:

```markdown
### TLS silently falls back to Traefik default

**Pre-Plan-1 installs** had a Traefik config that always tried TLS-ALPN-01
ACME. For internal-only hosts, this silently failed and Traefik served its
built-in self-signed cert with no log signal. Plan 1 added a loud-failure
gate; pre-Plan-1 installs surface via the migration banner in the admin UI
and the `TLS WARN` line in `agenthub status`.

Fix: `agenthub reconfigure-tls` (or [Fix now] in the UI).
```

- [ ] **Step 3: Commit**

```bash
git add docs/troubleshooting.md
git commit -m "docs(troubleshooting): TLS section with common failure modes"
```

(Obsidian docs are outside the repo — commit separately or note in the change log.)

---

## Self-Review

**Spec coverage (final):**
- ✅ TLS health probe with 60s cache (Task 1)
- ✅ `/api/health` extension (Task 2)
- ✅ TlsCard with Reconfigure/Renew/Test buttons (Task 3)
- ✅ MigrationBanner with localStorage dismissal (Task 4)
- ✅ `agenthub status` TLS line (Task 5)
- ✅ Real `/tls/test` endpoint replacing Plan 4 stub (Task 2)
- ✅ Troubleshooting docs (Task 7)
- ✅ All five plans together cover the full spec — `2026-05-05-flexible-tls-install-design.md` sections all addressed

**Placeholder scan:** No "TODO" / "TBD". Plan 4's stub for `/tls/test` is replaced in Task 2.

**Type consistency:** `TlsHealth` (server-internal) and `TlsHealthResponse` (web-facing) have identical shape — could share a type via a small `@agenthub/types` package later, but cross-package type sharing is out of scope here. The duplication is contained.

---

## Whole-program completion

After Plan 5 is merged, the spec is fully implemented. Final sanity:

- [ ] **Run the e2e script with the new TLS modes covered**

Update `scripts/e2e-full.js` to add:
- Self-CA install path
- Reconfigure-TLS round-trip (install in public-alpn, reconfigure to self-ca, verify cert flips, reconfigure back)
- Loud-failure gate verification (deliberately bad config → exit 3)

- [ ] **Tag the whole program**

```bash
git tag -a tls-flexible-install-complete -m "Flexible TLS install: all 5 plans verified end-to-end"
```
