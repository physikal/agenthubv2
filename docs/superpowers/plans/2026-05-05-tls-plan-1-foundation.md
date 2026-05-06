# TLS Plan 1: Foundation + Loud-Failure Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Traefik's cert-resolver config from the base compose into a generated `traefik.override.yml`, add a cert-validity gate to the install probe, and migrate existing installs on first update — eliminating the silent self-signed-fallback bug.

**Architecture:** A new `packages/installer/src/lib/tls/render-override.ts` module owns generation of `compose/traefik.override.yml` from `InstallConfig`. The base `compose/docker-compose.yml` becomes TLS-mode-agnostic (no `--certificatesresolvers.*` flags). The installer always generates the override file before `docker compose up`, and `headless.ts`'s `probeFrontDoor` is extended to read the live serving cert and fail loudly if Traefik is serving its built-in `CN=TRAEFIK DEFAULT CERT` default. Existing installs migrate via a one-shot at the start of `agenthub update`.

**Tech Stack:** TypeScript ESM, Node 22, Vitest, js-yaml, openssl s_client (called via execFileSync), Docker Compose v2.

**Spec reference:** `docs/superpowers/specs/2026-05-05-flexible-tls-install-design.md` — Sections "Compose shape", "Loud-failure semantics", and "Migration / rollout" land in this plan.

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `packages/installer/src/lib/tls/render-override.ts` | new | Render `traefik.override.yml` content from InstallConfig (only `public-alpn` mode in this plan; later plans add `dns-01` and `self-ca` branches) |
| `packages/installer/src/lib/tls/render-override.test.ts` | new | Snapshot tests for each mode's output |
| `packages/installer/src/lib/tls/probe-cert.ts` | new | Wraps `openssl s_client` to read the cert Traefik is serving + parse issuer + dates |
| `packages/installer/src/lib/tls/probe-cert.test.ts` | new | Unit tests with cert fixtures |
| `packages/installer/src/lib/tls/migrate.ts` | new | First-run-after-upgrade migration: if no override exists, write one based on existing `.env` values |
| `packages/installer/src/lib/tls/migrate.test.ts` | new | Migration tests |
| `packages/installer/src/lib/config.ts` | modify | Add `tlsMode: 'auto' \| 'public-alpn' \| 'dns-01' \| 'self-ca'` field, `applyEnvOverrides` reads `AGENTHUB_TLS_MODE`, `renderEnv` writes `COMPOSE_FILE=docker-compose.yml:traefik.override.yml` (only when override is present) |
| `packages/installer/src/lib/config.test.ts` | modify | Cover new field |
| `packages/installer/src/run.ts` | modify | Call `renderTraefikOverride` before `composePull`/`composeUp` when mode != localhost |
| `packages/installer/src/headless.ts` | modify | Extend `probeFrontDoor` with cert-validity check + actionable error message |
| `compose/docker-compose.yml` | modify | Strip `--certificatesresolvers.le.acme.tlschallenge=true`, `--certificatesresolvers.le.acme.email`, `--certificatesresolvers.le.acme.storage` and the `traefik.http.routers.agenthub.tls.certresolver=le` label (the label moves into the override) |
| `compose/.env.example` | modify | Document `AGENTHUB_TLS_MODE` |
| `scripts/agenthub` | modify | `update` verb runs migration before `docker compose up` |

---

## Task 1: Add `tlsMode` field to InstallConfig

**Files:**
- Modify: `packages/installer/src/lib/config.ts:1-173`
- Modify: `packages/installer/src/lib/config.test.ts`

- [ ] **Step 1: Read existing config.test.ts to confirm test framework + fixture style**

Run: `cat packages/installer/src/lib/config.test.ts | head -30`

Expected: a vitest-style test file using `describe`/`it`/`expect`. Note the existing fixture pattern.

- [ ] **Step 2: Write failing test for new `tlsMode` field**

Append to `packages/installer/src/lib/config.test.ts`:

```typescript
describe("tlsMode", () => {
  it("defaults to 'auto'", () => {
    expect(emptyConfig().tlsMode).toBe("auto");
  });

  it("applies AGENTHUB_TLS_MODE override", () => {
    const cfg = applyEnvOverrides(emptyConfig(), {
      AGENTHUB_TLS_MODE: "dns-01",
    });
    expect(cfg.tlsMode).toBe("dns-01");
  });

  it("rejects unknown TLS mode at validation", () => {
    const cfg = applyEnvOverrides(emptyConfig(), {
      AGENTHUB_TLS_MODE: "wat",
    });
    expect(missingRequiredForHeadless(cfg)).toContain(
      "AGENTHUB_TLS_MODE (got 'wat'; valid: auto, public-alpn, dns-01, self-ca)",
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/installer && pnpm test -- config.test`

Expected: 3 failures (`tlsMode` doesn't exist on `InstallConfig`).

- [ ] **Step 4: Implement the field + override + validation**

Edit `packages/installer/src/lib/config.ts`:

Add to the type union near the top:

```typescript
export type TlsMode = "auto" | "public-alpn" | "dns-01" | "self-ca";
const VALID_TLS_MODES: readonly TlsMode[] = [
  "auto",
  "public-alpn",
  "dns-01",
  "self-ca",
] as const;
```

Add to `InstallConfig`:

```typescript
  tlsMode: TlsMode;
```

Add to `emptyConfig()`:

```typescript
    tlsMode: "auto",
```

Add to `applyEnvOverrides`:

```typescript
  if (env["AGENTHUB_TLS_MODE"]) {
    next.tlsMode = env["AGENTHUB_TLS_MODE"] as TlsMode;
  }
```

Extend `missingRequiredForHeadless`:

```typescript
  if (!VALID_TLS_MODES.includes(cfg.tlsMode)) {
    missing.push(
      `AGENTHUB_TLS_MODE (got '${cfg.tlsMode}'; valid: ${VALID_TLS_MODES.join(", ")})`,
    );
  }
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd packages/installer && pnpm test -- config.test`

Expected: all tests pass.

- [ ] **Step 6: Run typecheck**

Run: `cd packages/installer && pnpm typecheck`

Expected: clean exit.

- [ ] **Step 7: Commit**

```bash
git add packages/installer/src/lib/config.ts packages/installer/src/lib/config.test.ts
git commit -m "feat(installer): add tlsMode field with validated env override"
```

---

## Task 2: Resolve auto-mode to a concrete strategy

**Files:**
- Create: `packages/installer/src/lib/tls/resolve-mode.ts`
- Create: `packages/installer/src/lib/tls/resolve-mode.test.ts`

The `auto` mode needs a deterministic resolver that maps `(domain, env)` to one of `public-alpn` / `dns-01` / `self-ca` / `none` (where `none` means "no override; localhost mode").

- [ ] **Step 1: Write failing tests**

Create `packages/installer/src/lib/tls/resolve-mode.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveTlsMode } from "./resolve-mode.js";

describe("resolveTlsMode", () => {
  it("returns 'none' for localhost domain in auto mode", () => {
    expect(resolveTlsMode("auto", "localhost", {})).toBe("none");
  });

  it("returns 'dns-01' when AGENTHUB_TLS_DNS_PROVIDER is set", () => {
    expect(
      resolveTlsMode("auto", "foo.com", {
        AGENTHUB_TLS_DNS_PROVIDER: "cloudflare",
      }),
    ).toBe("dns-01");
  });

  it("returns 'public-alpn' for real domain with no DNS provider", () => {
    expect(resolveTlsMode("auto", "foo.com", {})).toBe("public-alpn");
  });

  it("respects explicit non-auto mode regardless of env", () => {
    expect(
      resolveTlsMode("self-ca", "foo.com", {
        AGENTHUB_TLS_DNS_PROVIDER: "cloudflare",
      }),
    ).toBe("self-ca");
  });

  it("returns 'none' for explicit public-alpn on localhost (degenerate)", () => {
    // public-alpn with localhost doesn't make sense; resolver demotes to 'none'
    // so we don't try to ACME for the literal hostname 'localhost'
    expect(resolveTlsMode("public-alpn", "localhost", {})).toBe("none");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/installer && pnpm test -- resolve-mode`

Expected: import error (`resolve-mode.js` doesn't exist).

- [ ] **Step 3: Implement `resolveTlsMode`**

Create `packages/installer/src/lib/tls/resolve-mode.ts`:

```typescript
import type { TlsMode } from "../config.js";

export type ResolvedTlsMode = "public-alpn" | "dns-01" | "self-ca" | "none";

/**
 * Maps the user's declared mode + domain + env to a concrete TLS strategy.
 *
 * - `none` means "no Traefik override; rely on the default cert" — used for
 *   localhost installs where there is no real domain to certify.
 * - Auto-mode infers the strategy from supplied env vars: presence of a DNS
 *   provider env var → dns-01; otherwise → public-alpn.
 * - Explicit non-auto modes are honored verbatim, except public-alpn on
 *   localhost which collapses to `none` (Let's Encrypt won't certify the
 *   literal hostname `localhost`, so attempting it is pure churn).
 */
export function resolveTlsMode(
  declared: TlsMode,
  domain: string,
  env: Record<string, string | undefined>,
): ResolvedTlsMode {
  if (domain === "localhost") return "none";

  if (declared === "public-alpn") return "public-alpn";
  if (declared === "dns-01") return "dns-01";
  if (declared === "self-ca") return "self-ca";

  // auto: infer
  if (env["AGENTHUB_TLS_DNS_PROVIDER"]) return "dns-01";
  return "public-alpn";
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/installer && pnpm test -- resolve-mode`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/installer/src/lib/tls/resolve-mode.ts packages/installer/src/lib/tls/resolve-mode.test.ts
git commit -m "feat(installer): add resolveTlsMode for auto-mode inference"
```

---

## Task 3: `renderTraefikOverride` for public-alpn mode

**Files:**
- Create: `packages/installer/src/lib/tls/render-override.ts`
- Create: `packages/installer/src/lib/tls/render-override.test.ts`

This task only handles `public-alpn` and `none`. Plans 2 and 3 add the `dns-01` and `self-ca` branches.

- [ ] **Step 1: Write failing tests**

Create `packages/installer/src/lib/tls/render-override.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { load as parseYaml } from "js-yaml";
import { renderTraefikOverride } from "./render-override.js";

describe("renderTraefikOverride", () => {
  it("returns null for resolved mode 'none' (localhost)", () => {
    expect(
      renderTraefikOverride({
        mode: "none",
        domain: "localhost",
        tlsEmail: "",
      }),
    ).toBeNull();
  });

  it("renders public-alpn with the canonical Traefik flags", () => {
    const out = renderTraefikOverride({
      mode: "public-alpn",
      domain: "agenthub.example.com",
      tlsEmail: "ops@example.com",
    });
    expect(out).not.toBeNull();
    const parsed = parseYaml(out!) as Record<string, unknown>;
    const traefik = (parsed.services as Record<string, { command: string[] }>)[
      "traefik"
    ];
    expect(traefik.command).toEqual(
      expect.arrayContaining([
        "--certificatesresolvers.le.acme.tlschallenge=true",
        "--certificatesresolvers.le.acme.email=ops@example.com",
        "--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json",
      ]),
    );
  });

  it("attaches cert resolver to the agenthub router via labels", () => {
    const out = renderTraefikOverride({
      mode: "public-alpn",
      domain: "agenthub.example.com",
      tlsEmail: "ops@example.com",
    });
    const parsed = parseYaml(out!) as Record<string, unknown>;
    const server = (parsed.services as Record<string, { labels: string[] }>)[
      "agenthub-server"
    ];
    expect(server.labels).toContain(
      "traefik.http.routers.agenthub.tls.certresolver=le",
    );
  });

  it("throws when public-alpn is requested without an email", () => {
    expect(() =>
      renderTraefikOverride({
        mode: "public-alpn",
        domain: "agenthub.example.com",
        tlsEmail: "",
      }),
    ).toThrow(/AGENTHUB_TLS_EMAIL/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/installer && pnpm test -- render-override`

Expected: import error.

- [ ] **Step 3: Implement `renderTraefikOverride`**

Create `packages/installer/src/lib/tls/render-override.ts`:

```typescript
import { dump as dumpYaml } from "js-yaml";
import type { ResolvedTlsMode } from "./resolve-mode.js";

export interface RenderOverrideInput {
  mode: ResolvedTlsMode;
  domain: string;
  tlsEmail: string;
}

/**
 * Render the Traefik-specific compose override for the resolved TLS mode.
 *
 * Returns null for `none` (localhost): no override file needed, the base
 * compose's Traefik will serve its built-in default cert as fallback for
 * any Host without a cert resolver, which is the right behavior for local-
 * only access.
 *
 * Plans 2 and 3 extend this with the dns-01 and self-ca branches; this
 * plan only handles public-alpn (matching today's behavior post-refactor).
 */
export function renderTraefikOverride(input: RenderOverrideInput): string | null {
  if (input.mode === "none") return null;

  if (input.mode === "public-alpn") {
    if (!input.tlsEmail) {
      throw new Error(
        "public-alpn TLS mode requires AGENTHUB_TLS_EMAIL — Let's Encrypt " +
          "needs a contact email for expiry notifications.",
      );
    }
    return dumpYaml({
      services: {
        traefik: {
          command: [
            "--certificatesresolvers.le.acme.tlschallenge=true",
            `--certificatesresolvers.le.acme.email=${input.tlsEmail}`,
            "--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json",
          ],
        },
        "agenthub-server": {
          labels: ["traefik.http.routers.agenthub.tls.certresolver=le"],
        },
      },
    });
  }

  throw new Error(
    `renderTraefikOverride: mode '${input.mode}' is not implemented in this plan; ` +
      "Plan 2 (dns-01) and Plan 3 (self-ca) add the remaining branches.",
  );
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/installer && pnpm test -- render-override`

Expected: all 4 tests pass.

- [ ] **Step 5: Run typecheck**

Run: `cd packages/installer && pnpm typecheck`

Expected: clean exit.

- [ ] **Step 6: Commit**

```bash
git add packages/installer/src/lib/tls/render-override.ts packages/installer/src/lib/tls/render-override.test.ts
git commit -m "feat(installer): renderTraefikOverride for public-alpn mode"
```

---

## Task 4: Cert probe with openssl

**Files:**
- Create: `packages/installer/src/lib/tls/probe-cert.ts`
- Create: `packages/installer/src/lib/tls/probe-cert.test.ts`

Uses `openssl s_client` (always present on the install host) to connect to Traefik and parse the serving cert's issuer + dates. We test the parser with cert-text fixtures, and integration-test the s_client wrapper separately (gated on whether openssl is on the test PATH).

- [ ] **Step 1: Write failing test for the parser**

Create `packages/installer/src/lib/tls/probe-cert.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseOpensslOutput } from "./probe-cert.js";

const TRAEFIK_DEFAULT_OUTPUT = `
CONNECTED(00000003)
depth=0 CN=TRAEFIK DEFAULT CERT
verify return:1
---
Server certificate
subject=CN=TRAEFIK DEFAULT CERT
issuer=CN=TRAEFIK DEFAULT CERT
notBefore=Apr 25 00:43:25 2026 GMT
notAfter=Apr 25 00:43:25 2027 GMT
---
`;

const LE_OUTPUT = `
CONNECTED(00000003)
---
Server certificate
subject=CN=agenthub.example.com
issuer=C=US, O=Let's Encrypt, CN=R10
notBefore=Mar 1 12:00:00 2026 GMT
notAfter=May 30 12:00:00 2026 GMT
---
`;

describe("parseOpensslOutput", () => {
  it("identifies TRAEFIK DEFAULT CERT", () => {
    const out = parseOpensslOutput(TRAEFIK_DEFAULT_OUTPUT);
    expect(out.issuerCN).toBe("TRAEFIK DEFAULT CERT");
    expect(out.subjectCN).toBe("TRAEFIK DEFAULT CERT");
    expect(out.isTraefikDefault).toBe(true);
  });

  it("parses Let's Encrypt cert", () => {
    const out = parseOpensslOutput(LE_OUTPUT);
    expect(out.issuerCN).toBe("R10");
    expect(out.issuerO).toBe("Let's Encrypt");
    expect(out.subjectCN).toBe("agenthub.example.com");
    expect(out.isTraefikDefault).toBe(false);
    expect(out.notAfter.toISOString()).toBe("2026-05-30T12:00:00.000Z");
  });

  it("handles missing fields gracefully", () => {
    expect(() => parseOpensslOutput("")).toThrow(/no subject/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/installer && pnpm test -- probe-cert`

Expected: import error.

- [ ] **Step 3: Implement parser + s_client wrapper**

Create `packages/installer/src/lib/tls/probe-cert.ts`:

```typescript
import { execFileSync } from "node:child_process";

export interface ParsedCert {
  subjectCN: string;
  issuerCN: string;
  issuerO?: string;
  notBefore: Date;
  notAfter: Date;
  isTraefikDefault: boolean;
}

/**
 * Pull a single CN= value from a comma-separated DN string. Tolerates the two
 * forms openssl emits: `CN=foo` and `C=US, O=org, CN=foo`.
 */
function pickField(dn: string, key: string): string | undefined {
  const match = dn.match(new RegExp(`(?:^|,\\s*)${key}=([^,]+)`));
  return match ? match[1].trim() : undefined;
}

export function parseOpensslOutput(stdout: string): ParsedCert {
  const subject = stdout.match(/^subject=(.+)$/m)?.[1];
  const issuer = stdout.match(/^issuer=(.+)$/m)?.[1];
  const notBeforeStr = stdout.match(/^notBefore=(.+)$/m)?.[1];
  const notAfterStr = stdout.match(/^notAfter=(.+)$/m)?.[1];
  if (!subject) throw new Error("probe-cert: no subject in openssl output");
  if (!issuer) throw new Error("probe-cert: no issuer in openssl output");
  if (!notBeforeStr || !notAfterStr) {
    throw new Error("probe-cert: missing notBefore/notAfter in openssl output");
  }
  const subjectCN = pickField(subject, "CN") ?? "";
  const issuerCN = pickField(issuer, "CN") ?? "";
  const issuerO = pickField(issuer, "O");
  return {
    subjectCN,
    issuerCN,
    ...(issuerO !== undefined ? { issuerO } : {}),
    notBefore: new Date(notBeforeStr),
    notAfter: new Date(notAfterStr),
    isTraefikDefault: issuerCN === "TRAEFIK DEFAULT CERT",
  };
}

/**
 * Connect to host:port via TLS using SNI=domain, return the parsed serving
 * cert. Throws on connection failure; never returns nullable.
 */
export function probeServingCert(
  host: string,
  port: number,
  sni: string,
): ParsedCert {
  const stdout = execFileSync(
    "openssl",
    [
      "s_client",
      "-connect",
      `${host}:${port}`,
      "-servername",
      sni,
      "-showcerts",
    ],
    { input: "", stdio: ["pipe", "pipe", "ignore"], timeout: 10_000 },
  ).toString();
  // openssl ends with `---\n` after the cert block; we want the section that
  // contains subject= / issuer= / notBefore= / notAfter= which follows the
  // certificate chain.
  return parseOpensslOutput(stdout);
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/installer && pnpm test -- probe-cert`

Expected: all 3 tests pass.

- [ ] **Step 5: Run typecheck**

Run: `cd packages/installer && pnpm typecheck`

Expected: clean exit.

- [ ] **Step 6: Commit**

```bash
git add packages/installer/src/lib/tls/probe-cert.ts packages/installer/src/lib/tls/probe-cert.test.ts
git commit -m "feat(installer): probe-cert wrapper around openssl s_client"
```

---

## Task 5: Wire `renderTraefikOverride` into install flow

**Files:**
- Modify: `packages/installer/src/run.ts`
- Modify: `packages/installer/src/lib/config.ts` (add `tlsEmail` use is already there; add `COMPOSE_FILE` to renderEnv)

- [ ] **Step 1: Read run.ts to confirm current flow**

Run: `cat packages/installer/src/run.ts`

Note the order: `writeEnvFile` → `composePull` → `composeUp` → `bootstrapInfisical`. Override generation needs to happen after `writeEnvFile` and before `composePull`.

- [ ] **Step 2: Write failing test for `renderEnv` COMPOSE_FILE behavior**

Append to `packages/installer/src/lib/config.test.ts`:

```typescript
describe("renderEnv COMPOSE_FILE", () => {
  it("omits COMPOSE_FILE for localhost installs", () => {
    const cfg = { ...emptyConfig(), domain: "localhost" };
    const env = renderEnv(cfg);
    expect(env).not.toContain("COMPOSE_FILE=");
  });

  it("sets COMPOSE_FILE for non-localhost installs", () => {
    const cfg = { ...emptyConfig(), domain: "foo.com", tlsEmail: "x@y.com" };
    const env = renderEnv(cfg);
    expect(env).toContain(
      "COMPOSE_FILE=docker-compose.yml:traefik.override.yml",
    );
  });
});
```

- [ ] **Step 3: Run test to confirm it fails**

Run: `cd packages/installer && pnpm test -- config.test`

Expected: 2 new failures.

- [ ] **Step 4: Update `renderEnv` to write COMPOSE_FILE conditionally**

Edit `packages/installer/src/lib/config.ts`'s `renderEnv` function. Add at the top of the returned array (after `# Generated by agenthub-install`):

```typescript
    ...(cfg.domain === "localhost"
      ? []
      : [`COMPOSE_FILE=docker-compose.yml:traefik.override.yml`]),
```

- [ ] **Step 5: Run config.test, verify it passes**

Run: `cd packages/installer && pnpm test -- config.test`

Expected: all pass.

- [ ] **Step 6: Update `runInstall` in run.ts to render the override**

Edit `packages/installer/src/run.ts`. After `const envFile = writeEnvFile(final, composeDir);`:

```typescript
  // Generate traefik.override.yml. For localhost installs this is a no-op
  // (returns null) — the base compose runs without a cert resolver and
  // serves its default cert, which is the right behavior for local-only.
  await writeTraefikOverride(final, composeDir, onLog);
```

Add the import + helper at the top:

```typescript
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renderTraefikOverride } from "./lib/tls/render-override.js";
import { resolveTlsMode } from "./lib/tls/resolve-mode.js";
```

Add the helper function below `runInstall`:

```typescript
async function writeTraefikOverride(
  cfg: InstallConfig,
  composeDir: string,
  onLog: (line: string) => void,
): Promise<void> {
  const resolved = resolveTlsMode(cfg.tlsMode, cfg.domain, process.env);
  const overridePath = join(composeDir, "traefik.override.yml");
  if (resolved === "none") {
    if (existsSync(overridePath)) {
      unlinkSync(overridePath);
      onLog(`removed ${overridePath} (localhost install)`);
    }
    return;
  }
  const yaml = renderTraefikOverride({
    mode: resolved,
    domain: cfg.domain,
    tlsEmail: cfg.tlsEmail,
  });
  if (!yaml) return;
  writeFileSync(overridePath, yaml, { mode: 0o644 });
  onLog(`wrote ${overridePath} (mode: ${resolved})`);
}
```

- [ ] **Step 7: Run typecheck**

Run: `cd packages/installer && pnpm typecheck`

Expected: clean exit.

- [ ] **Step 8: Run all installer tests**

Run: `cd packages/installer && pnpm test`

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add packages/installer/src/run.ts packages/installer/src/lib/config.ts packages/installer/src/lib/config.test.ts
git commit -m "feat(installer): generate traefik.override.yml during install"
```

---

## Task 6: Strip cert-resolver flags from base docker-compose.yml

**Files:**
- Modify: `compose/docker-compose.yml:23-38`
- Modify: `compose/docker-compose.yml:196-201` (agenthub-server labels)

- [ ] **Step 1: Read current Traefik service block**

Run: `sed -n '20,50p' compose/docker-compose.yml`

Confirm three lines need removal: `--certificatesresolvers.le.acme.tlschallenge=true`, `--certificatesresolvers.le.acme.email=…`, `--certificatesresolvers.le.acme.storage=…`. And in `agenthub-server.labels`: `traefik.http.routers.agenthub.tls.certresolver=le`.

- [ ] **Step 2: Remove the three command lines**

Edit `compose/docker-compose.yml`. Replace:

```yaml
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      - --certificatesresolvers.le.acme.tlschallenge=true
      - --certificatesresolvers.le.acme.email=${TLS_EMAIL}
      - --certificatesresolvers.le.acme.storage=/letsencrypt/acme.json
    ports:
```

with:

```yaml
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
    ports:
```

- [ ] **Step 3: Remove the certresolver label from agenthub-server**

Replace:

```yaml
      - traefik.http.routers.agenthub.rule=${AGENTHUB_HOST_RULE}
      - traefik.http.routers.agenthub.entrypoints=websecure
      - traefik.http.routers.agenthub.tls.certresolver=le
      - traefik.http.services.agenthub.loadbalancer.server.port=3000
```

with:

```yaml
      - traefik.http.routers.agenthub.rule=${AGENTHUB_HOST_RULE}
      - traefik.http.routers.agenthub.entrypoints=websecure
      - traefik.http.routers.agenthub.tls=true
      - traefik.http.services.agenthub.loadbalancer.server.port=3000
```

(`tls=true` keeps TLS termination on but defers certresolver assignment to the override file.)

- [ ] **Step 4: Sanity-check compose still parses**

Run: `cd compose && docker compose --env-file=/dev/null config 2>&1 | head -20`

Expected: parses without error (warnings about missing env vars are fine).

- [ ] **Step 5: Commit**

```bash
git add compose/docker-compose.yml
git commit -m "refactor(compose): move cert-resolver config to traefik.override.yml"
```

---

## Task 7: Migration helper for existing installs

**Files:**
- Create: `packages/installer/src/lib/tls/migrate.ts`
- Create: `packages/installer/src/lib/tls/migrate.test.ts`

When an existing v2 install upgrades, it has a `compose/.env` but no `traefik.override.yml` and no `COMPOSE_FILE` line in `.env`. The migration reads `.env`, infers a mode, writes the override, and appends `COMPOSE_FILE`.

- [ ] **Step 1: Write failing tests**

Create `packages/installer/src/lib/tls/migrate.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateTlsConfig } from "./migrate.js";

describe("migrateTlsConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agenthub-migrate-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op when override already exists", () => {
    writeFileSync(join(dir, ".env"), "DOMAIN=foo.com\nTLS_EMAIL=x@y.com\n");
    writeFileSync(join(dir, "traefik.override.yml"), "services: {}\n");
    const result = migrateTlsConfig(dir);
    expect(result.action).toBe("noop-already-migrated");
  });

  it("is a no-op for localhost installs", () => {
    writeFileSync(join(dir, ".env"), "DOMAIN=localhost\n");
    const result = migrateTlsConfig(dir);
    expect(result.action).toBe("noop-localhost");
    expect(existsSync(join(dir, "traefik.override.yml"))).toBe(false);
  });

  it("infers public-alpn for real domain with TLS_EMAIL", () => {
    writeFileSync(join(dir, ".env"), "DOMAIN=foo.com\nTLS_EMAIL=x@y.com\n");
    const result = migrateTlsConfig(dir);
    expect(result.action).toBe("migrated");
    expect(result.inferredMode).toBe("public-alpn");
    expect(existsSync(join(dir, "traefik.override.yml"))).toBe(true);
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("COMPOSE_FILE=docker-compose.yml:traefik.override.yml");
  });

  it("preserves other .env lines verbatim", () => {
    const original = "DOMAIN=foo.com\nTLS_EMAIL=x@y.com\nINFISICAL_PROJECT_ID=abc\n";
    writeFileSync(join(dir, ".env"), original);
    migrateTlsConfig(dir);
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("INFISICAL_PROJECT_ID=abc");
    expect(env).toContain("DOMAIN=foo.com");
  });

  it("throws when real-domain install has no TLS_EMAIL", () => {
    writeFileSync(join(dir, ".env"), "DOMAIN=foo.com\n");
    expect(() => migrateTlsConfig(dir)).toThrow(/TLS_EMAIL/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/installer && pnpm test -- migrate`

Expected: import error.

- [ ] **Step 3: Implement `migrateTlsConfig`**

Create `packages/installer/src/lib/tls/migrate.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderTraefikOverride } from "./render-override.js";

export interface MigrateResult {
  action: "noop-already-migrated" | "noop-localhost" | "migrated";
  inferredMode?: "public-alpn";
  overridePath?: string;
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Migrate an existing pre-Plan-1 install: if no traefik.override.yml exists,
 * generate one from the existing .env's DOMAIN + TLS_EMAIL (always inferring
 * public-alpn — the only mode that existed pre-migration). Idempotent on
 * already-migrated dirs.
 *
 * Called on the host before `docker compose up` during `agenthub update`.
 * Operates on real files because we need to rewrite .env in place.
 */
export function migrateTlsConfig(composeDir: string): MigrateResult {
  const overridePath = join(composeDir, "traefik.override.yml");
  const envPath = join(composeDir, ".env");

  if (existsSync(overridePath)) {
    return { action: "noop-already-migrated" };
  }
  if (!existsSync(envPath)) {
    throw new Error(
      `migrateTlsConfig: no .env at ${envPath}. Is composeDir correct?`,
    );
  }

  const envText = readFileSync(envPath, "utf8");
  const env = parseEnvFile(envText);
  const domain = env["DOMAIN"] ?? "localhost";

  if (domain === "localhost") {
    return { action: "noop-localhost" };
  }

  const tlsEmail = env["TLS_EMAIL"];
  if (!tlsEmail) {
    throw new Error(
      `migrateTlsConfig: domain=${domain} but TLS_EMAIL is missing from .env. ` +
        `Either add TLS_EMAIL to ${envPath} or set DOMAIN=localhost.`,
    );
  }

  const yaml = renderTraefikOverride({
    mode: "public-alpn",
    domain,
    tlsEmail,
  });
  if (!yaml) {
    throw new Error(
      "migrateTlsConfig: renderTraefikOverride returned null for non-localhost — bug",
    );
  }
  writeFileSync(overridePath, yaml, { mode: 0o644 });

  // Append COMPOSE_FILE if not already present
  const composeFileLine = "COMPOSE_FILE=docker-compose.yml:traefik.override.yml";
  if (!envText.includes("COMPOSE_FILE=")) {
    const newline = envText.endsWith("\n") ? "" : "\n";
    writeFileSync(envPath, `${envText}${newline}${composeFileLine}\n`, {
      mode: 0o600,
    });
  }

  return {
    action: "migrated",
    inferredMode: "public-alpn",
    overridePath,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/installer && pnpm test -- migrate`

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/installer/src/lib/tls/migrate.ts packages/installer/src/lib/tls/migrate.test.ts
git commit -m "feat(installer): migrateTlsConfig for first-update after Plan 1"
```

---

## Task 8: Wire migration into `agenthub update`

**Files:**
- Modify: `scripts/agenthub`

- [ ] **Step 1: Read current `agenthub` CLI structure**

Run: `grep -n "^update\\|^action_update\\|^case " scripts/agenthub | head -30`

Find the `update` action's main function (likely `action_update` or similar). Note that the script self-updates first, then runs `docker compose up`.

- [ ] **Step 2: Add migration invocation before `docker compose up`**

Find the line in the update action that runs `docker compose up -d` (likely after pulling the latest images and before recreating the server). Insert immediately before:

```bash
# TLS config migration: ensures pre-Plan-1 installs generate their override
# before Traefik restarts. Idempotent on installs that already have it.
node "$AGENTHUB_DIR/packages/installer/dist/lib/tls/migrate-cli.js" \
  "$AGENTHUB_DIR/compose" || {
  echo "[agenthub] TLS migration failed — refusing to upgrade Traefik" >&2
  exit 1
}
```

- [ ] **Step 3: Create the CLI shim**

Create `packages/installer/src/lib/tls/migrate-cli.ts`:

```typescript
#!/usr/bin/env node
/**
 * CLI entry point for migrateTlsConfig — invoked by `scripts/agenthub update`.
 * Exits 0 on success (incl. no-op cases), non-zero on failure with a clear msg.
 */
import { migrateTlsConfig } from "./migrate.js";

function main(): void {
  const composeDir = process.argv[2];
  if (!composeDir) {
    console.error("usage: migrate-cli.js <composeDir>");
    process.exit(2);
  }
  try {
    const r = migrateTlsConfig(composeDir);
    if (r.action === "migrated") {
      console.log(
        `[migrate-tls] generated ${r.overridePath} (mode: ${r.inferredMode})`,
      );
    } else if (r.action === "noop-already-migrated") {
      console.log("[migrate-tls] already migrated, no changes");
    } else if (r.action === "noop-localhost") {
      console.log("[migrate-tls] localhost install, no override needed");
    }
  } catch (err) {
    console.error(
      "[migrate-tls] migration failed:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }
}

main();
```

Add to `packages/installer/package.json` `bin` map (read existing first, then merge):

```json
"bin": {
  "agenthub-install": "./bin/agenthub-install.js",
  "agenthub-migrate-tls": "./dist/lib/tls/migrate-cli.js"
}
```

- [ ] **Step 4: Build and verify the CLI runs**

Run:
```bash
cd packages/installer && pnpm build
node dist/lib/tls/migrate-cli.js /tmp/nonexistent 2>&1
```

Expected: error message about missing `.env`, exits non-zero (this verifies the entry point at least loads cleanly).

- [ ] **Step 5: Commit**

```bash
git add scripts/agenthub packages/installer/src/lib/tls/migrate-cli.ts packages/installer/package.json
git commit -m "feat(cli): run TLS migration before docker compose up in agenthub update"
```

---

## Task 9: Cert-validity gate in `probeFrontDoor`

**Files:**
- Modify: `packages/installer/src/headless.ts:31-55`

- [ ] **Step 1: Write failing integration test**

Create `packages/installer/src/headless.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { explainAcmeFailure } from "./headless.js";

describe("explainAcmeFailure", () => {
  it("returns dns-01 hints", () => {
    const msg = explainAcmeFailure("dns-01");
    expect(msg).toMatch(/wrong API token|zone|propagation/i);
  });

  it("returns public-alpn hints", () => {
    const msg = explainAcmeFailure("public-alpn");
    expect(msg).toMatch(/port 443|DNS A record|ISP/i);
  });

  it("returns generic hint for unknown mode", () => {
    expect(explainAcmeFailure("unknown" as never)).toMatch(/unexpected/i);
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd packages/installer && pnpm test -- headless`

Expected: import error (`explainAcmeFailure` not exported).

- [ ] **Step 3: Refactor `probeFrontDoor` and add `explainAcmeFailure`**

Edit `packages/installer/src/headless.ts`. Replace the existing `probeFrontDoor` function with:

```typescript
import { probeServingCert } from "./lib/tls/probe-cert.js";
import type { ResolvedTlsMode } from "./lib/tls/resolve-mode.js";

/**
 * Front-door probe: (1) waits for the URL to be reachable through Traefik,
 * (2) verifies Traefik isn't serving its built-in default cert (which would
 * mean ACME silently fell back). Throws with an actionable error on either.
 */
async function probeFrontDoor(
  domain: string,
  resolvedMode: ResolvedTlsMode,
): Promise<void> {
  const url = `https://${domain}/api/health`;
  const args = [
    "-ksf",
    "-m", "5",
    "--resolve", `${domain}:443:127.0.0.1`,
    url,
  ];
  let lastErr = "timeout";
  // ACME can take 30-60s for DNS-01 propagation; self-ca is instant.
  const reachableDeadline = Date.now() + (resolvedMode === "self-ca" ? 15_000 : 90_000);
  while (Date.now() < reachableDeadline) {
    try {
      execFileSync("curl", args, { stdio: "pipe" });
      lastErr = "";
      break;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : "curl failed";
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  if (lastErr) {
    throw new Error(
      `Install completed but ${url} is unreachable through the front-door proxy. ` +
        `Check 'docker logs agenthub-traefik-1' and 'docker logs agenthub-agenthub-server-1'. ` +
        `Last curl error: ${lastErr}`,
    );
  }

  // Reachable, but is the cert real? (Localhost installs skip — they
  // intentionally use the default cert.)
  if (resolvedMode === "none") return;

  const cert = probeServingCert("127.0.0.1", 443, domain);
  if (cert.isTraefikDefault) {
    throw new Error(
      `Install completed but Traefik is serving its default self-signed cert ` +
        `for ${domain}. ${
          resolvedMode === "self-ca"
            ? "Self-CA initialization did not complete."
            : `ACME ${resolvedMode === "public-alpn" ? "TLS-ALPN-01" : "DNS-01"} did not complete.`
        } ` +
        `Check 'docker logs agenthub-traefik-1 | grep -iE "acme|tls"' for the reason. ` +
        explainAcmeFailure(resolvedMode),
    );
  }
}

export function explainAcmeFailure(mode: ResolvedTlsMode | string): string {
  if (mode === "dns-01") {
    return "Common causes: wrong API token, token lacks the right zone, propagation timeout.";
  }
  if (mode === "public-alpn") {
    return "Common causes: port 443 not reachable from the public internet, DNS A record missing or wrong, ISP blocks inbound :443.";
  }
  if (mode === "self-ca") {
    return "Common causes: traefik-self-ca-init container failed — check its logs.";
  }
  return `unexpected mode '${mode}' — please file a bug.`;
}
```

Update the call site in `runHeadless`:

```typescript
const resolved = resolveTlsMode(cfg.tlsMode, cfg.domain, process.env);
console.log("verifying front-door routing via Traefik…");
await probeFrontDoor(cfg.domain, resolved);
```

Add the import at the top:

```typescript
import { resolveTlsMode } from "./lib/tls/resolve-mode.js";
```

- [ ] **Step 4: Run tests**

Run: `cd packages/installer && pnpm test`

Expected: all pass.

- [ ] **Step 5: Run typecheck**

Run: `cd packages/installer && pnpm typecheck`

Expected: clean exit.

- [ ] **Step 6: Commit**

```bash
git add packages/installer/src/headless.ts packages/installer/src/headless.test.ts
git commit -m "feat(installer): cert-validity gate in probeFrontDoor"
```

---

## Task 10: Update `.env.example` documentation

**Files:**
- Modify: `compose/.env.example:7-15`

- [ ] **Step 1: Add `AGENTHUB_TLS_MODE` to `.env.example`**

Edit `compose/.env.example`. After the `DOMAIN=localhost` line, add:

```
# TLS strategy. One of:
#   auto         (default — public-alpn for real domains, no ACME for localhost)
#   public-alpn  (Let's Encrypt via TLS-ALPN-01; needs port 443 reachable from internet)
#   dns-01       (Let's Encrypt via DNS-01 — for internal-only hosts; see Plan 2)
#   self-ca      (private self-signed CA; see Plan 3)
# AGENTHUB_TLS_MODE=auto
```

After the `TLS_EMAIL=…` line, add:

```
# Generated automatically by the installer when DOMAIN != localhost. Tells
# docker compose to layer the TLS-mode-specific override on top of the base
# compose. Don't edit by hand — run `agenthub reconfigure-tls` to change.
# COMPOSE_FILE=docker-compose.yml:traefik.override.yml
```

- [ ] **Step 2: Commit**

```bash
git add compose/.env.example
git commit -m "docs(env): document AGENTHUB_TLS_MODE and COMPOSE_FILE"
```

---

## Task 11: End-to-end verification

This task is manual and produces no code changes — it's the gate that says "Plan 1 is done."

- [ ] **Step 1: Fresh public-alpn install on a throwaway VM**

Stand up a Debian 12 VM with public IP + DNS pointing at it. Run:

```bash
curl -fsSL https://raw.githubusercontent.com/physikal/agenthubv2/<this-branch>/scripts/quick-install.sh \
  | AGENTHUB_AUTO_INSTALL=true \
    AGENTHUB_DOMAIN=test-install-1.<your-test-domain> \
    AGENTHUB_TLS_EMAIL=ops@example.com \
    AGENTHUB_ADMIN_PASSWORD=test \
    bash -s -- --non-interactive
```

Expected:
- `compose/traefik.override.yml` written, contains `tlschallenge=true`
- `compose/.env` contains `COMPOSE_FILE=docker-compose.yml:traefik.override.yml`
- `https://test-install-1.<domain>/api/health` returns 200 with a Let's Encrypt cert
- Install completes with exit code 0

- [ ] **Step 2: Loud-failure regression test — force ACME failure**

On the same VM (or a fresh one), block outbound :80 (LE TLS-ALPN-01 challenge connect-back), re-run the install. Expected:

- Install fails with exit 3 within 90s
- Error message mentions "Traefik is serving its default self-signed cert" + "TLS-ALPN-01 did not complete" + the `docker logs` hint
- NOT a silent install-succeeded-but-cert-is-wrong result

- [ ] **Step 3: Migration test on a pre-Plan-1 install**

Take a snapshot of an existing v2 install (one of the test VMs, NOT `.4.36` yet). Don't pre-generate the override; simulate an upgrade by:

```bash
cd /path/to/existing/agenthubv2
git fetch && git checkout <this-branch>
agenthub update
```

Expected:
- `agenthub update` logs: `[migrate-tls] generated …/traefik.override.yml (mode: public-alpn)`
- `compose/.env` gains the `COMPOSE_FILE=` line
- Traefik restarts cleanly, cert remains valid (no re-issuance, since storage path is unchanged)

- [ ] **Step 4: Mark Plan 1 done in commit log**

```bash
git tag -a tls-plan-1-complete -m "TLS Plan 1 (foundation + loud-failure gate) verified end-to-end"
```

---

## Self-Review

**Spec coverage check** (Sections in `2026-05-05-flexible-tls-install-design.md` that this plan addresses):

- ✅ "Compose shape" — strip flags from base, render override, COMPOSE_FILE plumbing (Tasks 3, 5, 6)
- ✅ "Migration on first update after this PR lands" — Tasks 7, 8
- ✅ "Loud-failure semantics" — Tasks 4, 9
- ✅ "localhost mode skips override" — Tasks 2, 5
- ❌ DNS-01 mode — Plan 2
- ❌ Self-CA — Plan 3
- ❌ Reconfigure CLI — Plan 4
- ❌ TLS health surface — Plan 5

All in-scope spec sections have a corresponding task. Out-of-scope items are explicitly deferred to later plans.

**Placeholder scan:** No "TODO", "TBD", "implement later" patterns. Every code block contains the actual code an engineer needs.

**Type consistency:** `TlsMode` (declared) vs `ResolvedTlsMode` (after `resolveTlsMode`) is used consistently — `Plan 1` only ever passes `ResolvedTlsMode` to `renderTraefikOverride` and `probeFrontDoor`. `InstallConfig.tlsMode` is the declared type.
