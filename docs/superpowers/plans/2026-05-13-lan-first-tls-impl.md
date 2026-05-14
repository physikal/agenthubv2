# LAN-first TLS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 4-mode TLS surface (`auto`/`public-alpn`/`dns-01`/`self-ca`) with a 2-mode access surface (`lan` default, `public` with sub-modes `public-alpn`/`dns-01`). Delete self-CA entirely. Auto-migrate existing installs. Tunnel mode is deferred to a follow-up PR.

**Architecture:** New `packages/installer/src/lib/access/` module owns mode resolution, compose rendering, and migration. The existing `lib/tls/` directory keeps only mode-agnostic helpers (probe-cert, lego-providers, preflight). Base `compose/docker-compose.yml` becomes TLS-agnostic — `:443` port and `websecure` entrypoint move to a public-mode-only override. Server reads `AGENTHUB_PUBLIC_URL` protocol to decide whether to set the cookie `Secure` flag. Web UI components rename from `Tls*` to `Access*`; server endpoints rename from `/api/admin/tls/*` to `/api/admin/access/*` (hard-rename; web UI ships in lockstep). Migration handles three pre-existing shapes (self-ca → lan, public-alpn/dns-01 → public + sub-mode, auto → lan or public depending on domain).

**Tech Stack:** TypeScript (Node 22, ESM), pnpm workspaces, Hono (server), React 19 + Vite (web), Ink (installer TUI), Traefik v3.6, Docker Compose, vitest, js-yaml.

**Reference spec:** `docs/superpowers/specs/2026-05-13-lan-first-tls-default.md`

---

## Pre-flight

- [ ] **Step 0.1: Confirm clean working tree on `main`**

Run: `git status && git log --oneline -1`
Expected: `working tree clean`, HEAD at `6d74d93 docs(spec): LAN-first TLS default…`

- [ ] **Step 0.2: Create implementation branch**

```bash
git switch -c feat/lan-first-tls-impl
```

- [ ] **Step 0.3: Sanity-run the test suite to baseline**

Run: `pnpm install && pnpm test`
Expected: all tests pass. Note the test count for diff-checking later.

- [ ] **Step 0.4: Sanity-run typecheck**

Run: `pnpm typecheck`
Expected: passes.

---

## Task 1: Foundation — `AccessMode` types

**Files:**
- Create: `packages/installer/src/lib/access/types.ts`
- Modify: `packages/installer/src/lib/config.ts`
- Test: covered indirectly by Task 2's resolve-mode tests.

- [ ] **Step 1.1: Create the new types file**

Create `packages/installer/src/lib/access/types.ts`:
```typescript
/**
 * Access mode — how the install is reached by users.
 * `tunnel` is reserved for a follow-up PR (Cloudflare Tunnel).
 */
export type AccessMode = "lan" | "public";

/**
 * TLS sub-mode, only meaningful when `accessMode === "public"`.
 */
export type PublicTlsMode = "public-alpn" | "dns-01";

export const VALID_ACCESS_MODES: readonly AccessMode[] = ["lan", "public"] as const;
export const VALID_PUBLIC_TLS_MODES: readonly PublicTlsMode[] = [
  "public-alpn",
  "dns-01",
] as const;
```

- [ ] **Step 1.2: Add `accessMode` field + new env var to `InstallConfig`**

In `packages/installer/src/lib/config.ts`, after the existing `TlsMode` definition (line 6), insert:
```typescript
import type { AccessMode, PublicTlsMode } from "./access/types.js";
export type { AccessMode, PublicTlsMode } from "./access/types.js";
```

Add `accessMode: AccessMode;` field to `InstallConfig` (after `tlsMode` at line 60). Set the default in `emptyConfig()` (around line 94) to `accessMode: "lan",`.

Keep the existing `tlsMode` field — migration reads it for the auto-upgrade path; new installs leave it as `"auto"` and let the access-mode-aware code path ignore it.

- [ ] **Step 1.3: Read `AGENTHUB_ACCESS_MODE` from env**

In `packages/installer/src/lib/config.ts`, inside `applyEnvOverrides` (around line 187, near the existing `AGENTHUB_TLS_MODE` block), add:
```typescript
if (env["AGENTHUB_ACCESS_MODE"]) {
  next.accessMode = env["AGENTHUB_ACCESS_MODE"] as AccessMode;
}
```

- [ ] **Step 1.4: Validate `AGENTHUB_ACCESS_MODE` in `missingRequiredForHeadless`**

In `packages/installer/src/lib/config.ts`, inside `missingRequiredForHeadless` (around line 241, near `VALID_TLS_MODES`), add the equivalent check:
```typescript
import { VALID_ACCESS_MODES } from "./access/types.js";
// ...inside the function, before the tls-mode check:
if (!VALID_ACCESS_MODES.includes(cfg.accessMode)) {
  missing.push(
    `AGENTHUB_ACCESS_MODE (got '${cfg.accessMode}'; valid: ${VALID_ACCESS_MODES.join(", ")})`,
  );
}
```

- [ ] **Step 1.5: Run typecheck**

Run: `pnpm typecheck`
Expected: passes. (No new tests yet — covered by Task 2.)

- [ ] **Step 1.6: Commit**

```bash
git add packages/installer/src/lib/access/types.ts packages/installer/src/lib/config.ts
git commit -m "feat(access): introduce AccessMode type + accessMode config field"
```

---

## Task 2: Foundation — `resolveAccessMode`

**Files:**
- Create: `packages/installer/src/lib/access/resolve-mode.ts`
- Create: `packages/installer/src/lib/access/resolve-mode.test.ts`

- [ ] **Step 2.1: Write the test file (failing)**

Create `packages/installer/src/lib/access/resolve-mode.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { resolveAccessMode, resolvePublicTlsMode } from "./resolve-mode.js";

describe("resolveAccessMode", () => {
  it("defaults to 'lan' when nothing is declared", () => {
    expect(resolveAccessMode("lan", "192.168.1.5", {})).toBe("lan");
  });

  it("returns 'lan' for localhost regardless of declared mode", () => {
    expect(resolveAccessMode("public", "localhost", {})).toBe("lan");
  });

  it("honors explicit 'public' for real domains", () => {
    expect(resolveAccessMode("public", "agenthub.example.com", {})).toBe("public");
  });

  it("honors explicit 'lan' for real domains (user opted out of TLS)", () => {
    expect(resolveAccessMode("lan", "agenthub.example.com", {})).toBe("lan");
  });
});

describe("resolvePublicTlsMode", () => {
  it("returns 'dns-01' when AGENTHUB_TLS_DNS_PROVIDER is set", () => {
    expect(resolvePublicTlsMode("auto", { AGENTHUB_TLS_DNS_PROVIDER: "cloudflare" }))
      .toBe("dns-01");
  });

  it("returns 'public-alpn' by default in auto", () => {
    expect(resolvePublicTlsMode("auto", {})).toBe("public-alpn");
  });

  it("honors explicit public-alpn", () => {
    expect(resolvePublicTlsMode("public-alpn", { AGENTHUB_TLS_DNS_PROVIDER: "cloudflare" }))
      .toBe("public-alpn");
  });

  it("honors explicit dns-01", () => {
    expect(resolvePublicTlsMode("dns-01", {})).toBe("dns-01");
  });
});
```

- [ ] **Step 2.2: Run the failing test**

Run: `pnpm --filter @agenthub/installer exec vitest run packages/installer/src/lib/access/resolve-mode.test.ts`
Expected: fails with "Cannot find module './resolve-mode.js'".

- [ ] **Step 2.3: Implement the resolver**

Create `packages/installer/src/lib/access/resolve-mode.ts`:
```typescript
import type { AccessMode, PublicTlsMode } from "./types.js";
import type { TlsMode } from "../config.js";

/**
 * Resolve the access mode for an install. Localhost always collapses to `lan`
 * (Let's Encrypt cannot certify the literal hostname). Otherwise the declared
 * mode is honored verbatim.
 */
export function resolveAccessMode(
  declared: AccessMode,
  domain: string,
  _env: Record<string, string | undefined>,
): AccessMode {
  if (domain === "localhost") return "lan";
  return declared;
}

/**
 * Resolve the TLS sub-mode for `public` access mode. Auto-mode infers from
 * env: presence of a DNS provider var → dns-01, otherwise → public-alpn.
 * Explicit values pass through.
 */
export function resolvePublicTlsMode(
  declaredTls: TlsMode,
  env: Record<string, string | undefined>,
): PublicTlsMode {
  if (declaredTls === "public-alpn") return "public-alpn";
  if (declaredTls === "dns-01") return "dns-01";
  if (env["AGENTHUB_TLS_DNS_PROVIDER"]) return "dns-01";
  return "public-alpn";
}
```

- [ ] **Step 2.4: Run the test (passes)**

Run: `pnpm --filter @agenthub/installer exec vitest run packages/installer/src/lib/access/resolve-mode.test.ts`
Expected: 6 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add packages/installer/src/lib/access/
git commit -m "feat(access): resolveAccessMode + resolvePublicTlsMode"
```

---

## Task 3: Foundation — `render-compose` per-mode rendering

**Files:**
- Create: `packages/installer/src/lib/access/render-compose.ts`
- Create: `packages/installer/src/lib/access/render-compose.test.ts`

This task replaces `render-override.ts` + `render-traefik-config.ts` + `render-dynamic-config.ts`. The new module emits three artifacts per call: the static Traefik config (`traefik.yml`), the dynamic redirect config (`dynamic/redirect.yml`, only when redirect needed), and the optional override (`traefik.override.yml`, only for `public + dns-01`).

- [ ] **Step 3.1: Write the failing tests**

Create `packages/installer/src/lib/access/render-compose.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import {
  renderTraefikStaticConfig,
  renderTraefikOverride,
  renderRedirectDynamic,
} from "./render-compose.js";

describe("renderTraefikStaticConfig", () => {
  it("lan: emits web entrypoint only, no cert resolver, no websecure", () => {
    const yaml = renderTraefikStaticConfig({
      accessMode: "lan",
      domain: "192.168.1.5",
      publicTlsMode: undefined,
      tlsEmail: "",
    });
    expect(yaml).toContain("entryPoints:");
    expect(yaml).toContain("web:");
    expect(yaml).toContain(":80");
    expect(yaml).not.toContain("websecure");
    expect(yaml).not.toContain("certificatesResolvers");
    expect(yaml).not.toContain(":443");
  });

  it("public + public-alpn: emits both entrypoints, tlsChallenge resolver", () => {
    const yaml = renderTraefikStaticConfig({
      accessMode: "public",
      domain: "agenthub.example.com",
      publicTlsMode: "public-alpn",
      tlsEmail: "ops@example.com",
    });
    expect(yaml).toContain("web:");
    expect(yaml).toContain("websecure:");
    expect(yaml).toContain(":80");
    expect(yaml).toContain(":443");
    expect(yaml).toContain("certificatesResolvers:");
    expect(yaml).toContain("tlsChallenge: {}");
    expect(yaml).toContain("email: ops@example.com");
  });

  it("public + dns-01: emits dnsChallenge resolver with provider", () => {
    const yaml = renderTraefikStaticConfig({
      accessMode: "public",
      domain: "agenthub.example.com",
      publicTlsMode: "dns-01",
      tlsEmail: "ops@example.com",
      dnsProvider: "cloudflare",
    });
    expect(yaml).toContain("dnsChallenge:");
    expect(yaml).toContain("provider: cloudflare");
  });

  it("throws when public mode is missing tlsEmail", () => {
    expect(() =>
      renderTraefikStaticConfig({
        accessMode: "public",
        domain: "agenthub.example.com",
        publicTlsMode: "public-alpn",
        tlsEmail: "",
      }),
    ).toThrow(/AGENTHUB_TLS_EMAIL/);
  });

  it("throws when public+dns-01 is missing dnsProvider", () => {
    expect(() =>
      renderTraefikStaticConfig({
        accessMode: "public",
        domain: "agenthub.example.com",
        publicTlsMode: "dns-01",
        tlsEmail: "ops@example.com",
      }),
    ).toThrow(/dnsProvider/);
  });
});

describe("renderTraefikOverride", () => {
  it("lan: returns null (no override needed)", () => {
    expect(
      renderTraefikOverride({
        accessMode: "lan",
        domain: "192.168.1.5",
        publicTlsMode: undefined,
        tlsEmail: "",
      }),
    ).toBeNull();
  });

  it("public + public-alpn: adds certresolver label to agenthub-server", () => {
    const yaml = renderTraefikOverride({
      accessMode: "public",
      domain: "agenthub.example.com",
      publicTlsMode: "public-alpn",
      tlsEmail: "ops@example.com",
    });
    expect(yaml).not.toBeNull();
    expect(yaml!).toContain("agenthub-server");
    expect(yaml!).toContain("traefik.http.routers.agenthub.tls.certresolver=le");
    expect(yaml!).not.toContain("services:\n  traefik:");
  });

  it("public + dns-01: adds DNS env vars on traefik service + certresolver label", () => {
    const yaml = renderTraefikOverride({
      accessMode: "public",
      domain: "agenthub.example.com",
      publicTlsMode: "dns-01",
      tlsEmail: "ops@example.com",
      dnsProvider: "cloudflare",
      dnsEnvVars: { CF_DNS_API_TOKEN: "${CF_DNS_API_TOKEN}" },
    });
    expect(yaml).not.toBeNull();
    expect(yaml!).toContain("CF_DNS_API_TOKEN");
    expect(yaml!).toContain("certresolver=le");
  });

  it("never emits `command:` on the traefik service (regression guard for #69)", () => {
    for (const mode of ["public-alpn", "dns-01"] as const) {
      const yaml = renderTraefikOverride({
        accessMode: "public",
        domain: "agenthub.example.com",
        publicTlsMode: mode,
        tlsEmail: "ops@example.com",
        dnsProvider: mode === "dns-01" ? "cloudflare" : undefined,
        dnsEnvVars: mode === "dns-01" ? { CF_DNS_API_TOKEN: "${CF_DNS_API_TOKEN}" } : {},
      });
      expect(yaml).not.toBeNull();
      expect(yaml!).not.toMatch(/^\s+command:/m);
    }
  });
});

describe("renderRedirectDynamic", () => {
  it("lan: returns null (no redirect needed; no HTTPS to redirect to)", () => {
    expect(renderRedirectDynamic({ accessMode: "lan" })).toBeNull();
  });

  it("public: emits HTTP→HTTPS redirect middleware", () => {
    const yaml = renderRedirectDynamic({ accessMode: "public" });
    expect(yaml).not.toBeNull();
    expect(yaml!).toContain("redirectScheme:");
    expect(yaml!).toContain("scheme: https");
  });
});
```

- [ ] **Step 3.2: Run the failing tests**

Run: `pnpm --filter @agenthub/installer exec vitest run packages/installer/src/lib/access/render-compose.test.ts`
Expected: fails with "Cannot find module './render-compose.js'".

- [ ] **Step 3.3: Implement the renderer**

Create `packages/installer/src/lib/access/render-compose.ts`:
```typescript
import { dump as dumpYaml } from "js-yaml";
import type { AccessMode, PublicTlsMode } from "./types.js";

export interface RenderInput {
  accessMode: AccessMode;
  domain: string;
  publicTlsMode: PublicTlsMode | undefined;
  tlsEmail: string;
  dnsProvider?: string;
  dnsEnvVars?: Record<string, string>;
}

/**
 * Render Traefik's static config (compose/traefik.yml).
 *
 * - lan: just the `web` entrypoint on :80. No cert resolver. No websecure.
 * - public + public-alpn: web + websecure (with TLS), LE resolver via tlsChallenge.
 * - public + dns-01: web + websecure, LE resolver via dnsChallenge (provider).
 *
 * The file is mounted read-only into the traefik container at /etc/traefik/
 * traefik.yml. See compose/docker-compose.yml for the volume + command flags.
 */
export function renderTraefikStaticConfig(input: RenderInput): string {
  if (input.accessMode === "lan") {
    return dumpYaml({
      entryPoints: { web: { address: ":80" } },
      providers: {
        docker: { exposedByDefault: false, network: "agenthub" },
      },
      log: { level: "INFO" },
    });
  }

  // public mode
  if (!input.tlsEmail) {
    throw new Error(
      "public access mode requires AGENTHUB_TLS_EMAIL — Let's Encrypt needs " +
        "a contact email for expiry notifications.",
    );
  }
  if (input.publicTlsMode === "dns-01" && !input.dnsProvider) {
    throw new Error(
      "public + dns-01 requires dnsProvider (lego provider name, e.g. 'cloudflare').",
    );
  }

  const resolver =
    input.publicTlsMode === "dns-01"
      ? {
          acme: {
            email: input.tlsEmail,
            storage: "/letsencrypt/acme.json",
            dnsChallenge: { provider: input.dnsProvider! },
          },
        }
      : {
          acme: {
            email: input.tlsEmail,
            storage: "/letsencrypt/acme.json",
            tlsChallenge: {},
          },
        };

  return dumpYaml({
    entryPoints: {
      web: {
        address: ":80",
        http: {
          redirections: {
            entryPoint: { to: "websecure", scheme: "https", permanent: true },
          },
        },
      },
      websecure: { address: ":443" },
    },
    certificatesResolvers: { le: resolver },
    providers: {
      docker: { exposedByDefault: false, network: "agenthub" },
      file: { directory: "/etc/traefik/dynamic", watch: true },
    },
    log: { level: "INFO" },
  });
}

/**
 * Render the per-install override file (compose/traefik.override.yml).
 *
 * - lan: returns null. The base compose is sufficient; no override file.
 * - public (any sub-mode): attaches `certresolver=le` to agenthub-server.
 * - public + dns-01: also pushes DNS provider env vars onto the traefik
 *   service so lego can authenticate against the DNS API at runtime.
 *
 * Must NEVER emit `services.traefik.command:` (list-replace footgun, see PR #69).
 */
export function renderTraefikOverride(input: RenderInput): string | null {
  if (input.accessMode === "lan") return null;

  if (!input.tlsEmail) {
    throw new Error(
      "public access mode requires AGENTHUB_TLS_EMAIL — Let's Encrypt needs " +
        "a contact email for expiry notifications.",
    );
  }

  const services: Record<string, unknown> = {
    "agenthub-server": {
      labels: ["traefik.http.routers.agenthub.tls.certresolver=le"],
    },
  };

  if (input.publicTlsMode === "dns-01") {
    if (!input.dnsProvider) {
      throw new Error("public + dns-01 requires dnsProvider.");
    }
    services["traefik"] = {
      environment: input.dnsEnvVars ?? {},
    };
  }

  return dumpYaml({ services });
}

/**
 * Render the dynamic-config redirect middleware (compose/dynamic/redirect.yml).
 *
 * - lan: returns null. No HTTPS endpoint, nothing to redirect.
 * - public: emits the `redirectScheme` middleware. The base entryPoint config
 *   above already wires the redirect; this file makes the middleware available
 *   for any router that wants to attach it via label.
 */
export function renderRedirectDynamic(input: {
  accessMode: AccessMode;
}): string | null {
  if (input.accessMode === "lan") return null;
  return dumpYaml({
    http: {
      middlewares: {
        "redirect-to-https": {
          redirectScheme: { scheme: "https", permanent: true },
        },
      },
    },
  });
}
```

- [ ] **Step 3.4: Run the tests (passing)**

Run: `pnpm --filter @agenthub/installer exec vitest run packages/installer/src/lib/access/render-compose.test.ts`
Expected: all 9 tests pass.

- [ ] **Step 3.5: Run typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 3.6: Commit**

```bash
git add packages/installer/src/lib/access/render-compose.ts packages/installer/src/lib/access/render-compose.test.ts
git commit -m "feat(access): render-compose for lan + public modes"
```

---

## Task 4: Compose base — port `:443` and `websecure` move to override-only

**Files:**
- Modify: `compose/docker-compose.yml`

The base compose currently exposes `:443:443` even when no TLS is configured. That's fine for `public` mode (override attaches a resolver). For `lan` mode there's nothing listening on :443; the port mapping is harmless but the spec calls for moving it out for cleanliness.

- [ ] **Step 4.1: Read the current traefik service ports**

Read `compose/docker-compose.yml` lines 20-46. The current ports block:
```yaml
ports:
  - "80:80"
  - "443:443"
  - "8443:8443"
```

`:8443` stays — that's Infisical's own TLS, independent of access mode.

- [ ] **Step 4.2: Remove `:443:443` from base, keep `:80` and `:8443`**

In `compose/docker-compose.yml`, find the `ports:` block under the `traefik` service (around line 33-36) and change to:
```yaml
ports:
  - "80:80"
  - "8443:8443"
  # :443 is added by traefik.override.yml in public access mode only.
```

The override file generated by Task 3's renderer doesn't include `ports:` today (compose-merge would replace the list, killing :80). To keep this safe, the override-merge for public mode adds `:443` via a new top-level rendering branch:

In `packages/installer/src/lib/access/render-compose.ts`, update `renderTraefikOverride` so the `public` branch ALSO emits the `:443` port. Replace the `services` declaration body with:
```typescript
const services: Record<string, unknown> = {
  traefik: {
    ports: ["80:80", "443:443", "8443:8443"],
  },
  "agenthub-server": {
    labels: ["traefik.http.routers.agenthub.tls.certresolver=le"],
  },
};
```

(The `ports:` list gets REPLACED by compose merge, so we must restate `:80` and `:8443` — this is the SAME footgun PR #69 fixed for `command:`. Adding a regression test for this in the next step.)

- [ ] **Step 4.3: Add regression test for the ports merge**

In `packages/installer/src/lib/access/render-compose.test.ts`, inside the `describe("renderTraefikOverride")` block, add:
```typescript
it("public: restates :80, :443, :8443 on traefik.ports so compose merge doesn't drop :80", () => {
  const yaml = renderTraefikOverride({
    accessMode: "public",
    domain: "agenthub.example.com",
    publicTlsMode: "public-alpn",
    tlsEmail: "ops@example.com",
  });
  expect(yaml).not.toBeNull();
  expect(yaml!).toMatch(/80:80/);
  expect(yaml!).toMatch(/443:443/);
  expect(yaml!).toMatch(/8443:8443/);
});
```

If the dns-01 branch also reaches this code (it does — it spreads through the same `services` object), it gets the same coverage via the existing dns-01 test.

- [ ] **Step 4.4: Run the tests**

Run: `pnpm --filter @agenthub/installer exec vitest run packages/installer/src/lib/access/render-compose.test.ts`
Expected: 10 tests pass.

- [ ] **Step 4.5: Commit**

```bash
git add compose/docker-compose.yml packages/installer/src/lib/access/render-compose.ts packages/installer/src/lib/access/render-compose.test.ts
git commit -m "feat(compose): move :443 to public-mode override; restate all ports to survive merge"
```

---

## Task 5: Server — cookie `Secure` flag honors `AGENTHUB_PUBLIC_URL` protocol

**Files:**
- Modify: `packages/server/src/routes/auth.ts:103-109`
- Create: `packages/server/src/routes/auth.test.ts`

The spec's "Cookie Secure on HTTP" risk: in `lan` mode the server runs over HTTP, but today's cookie gets `Secure: true` whenever `NODE_ENV=production`. The browser then refuses to send the cookie over `http://`, breaking login. Fix: condition `Secure` on the runtime URL protocol.

- [ ] **Step 5.1: Write the failing test**

Create `packages/server/src/routes/auth.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cookieSecureFromPublicUrl } from "./auth.js";

describe("cookieSecureFromPublicUrl", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns false when NODE_ENV is not production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AGENTHUB_PUBLIC_URL", "https://agenthub.example.com");
    expect(cookieSecureFromPublicUrl()).toBe(false);
  });

  it("returns false when PUBLIC_URL is http (lan mode)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AGENTHUB_PUBLIC_URL", "http://agenthub.local");
    expect(cookieSecureFromPublicUrl()).toBe(false);
  });

  it("returns true when prod + https PUBLIC_URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AGENTHUB_PUBLIC_URL", "https://agenthub.example.com");
    expect(cookieSecureFromPublicUrl()).toBe(true);
  });

  it("returns false when PUBLIC_URL is missing (defensive)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AGENTHUB_PUBLIC_URL", "");
    expect(cookieSecureFromPublicUrl()).toBe(false);
  });
});
```

- [ ] **Step 5.2: Run the failing test**

Run: `pnpm --filter @agenthub/server exec vitest run src/routes/auth.test.ts`
Expected: fails — `cookieSecureFromPublicUrl` not exported.

- [ ] **Step 5.3: Implement + use the helper**

In `packages/server/src/routes/auth.ts`, near the top of the file (after imports), add:
```typescript
/**
 * Decide whether the session cookie's `Secure` flag should be set. True only
 * when running in production AND the install is served over HTTPS. The
 * lan-http access mode runs over plain HTTP; setting `Secure` there prevents
 * the browser from sending the cookie back, breaking login.
 */
export function cookieSecureFromPublicUrl(): boolean {
  if (process.env["NODE_ENV"] !== "production") return false;
  const url = process.env["AGENTHUB_PUBLIC_URL"] ?? "";
  return url.startsWith("https://");
}
```

Then in the login handler (around `routes/auth.ts:103-109`), replace:
```typescript
setCookie(c, "session_token", token, {
  httpOnly: true,
  secure: process.env["NODE_ENV"] === "production",
  sameSite: "Lax",
  path: "/",
  maxAge: 2592000,
});
```
with:
```typescript
setCookie(c, "session_token", token, {
  httpOnly: true,
  secure: cookieSecureFromPublicUrl(),
  sameSite: "Lax",
  path: "/",
  maxAge: 2592000,
});
```

- [ ] **Step 5.4: Run the tests (passing)**

Run: `pnpm --filter @agenthub/server exec vitest run src/routes/auth.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5.5: Commit**

```bash
git add packages/server/src/routes/auth.ts packages/server/src/routes/auth.test.ts
git commit -m "fix(auth): drop cookie Secure flag for lan-http access mode

When AGENTHUB_PUBLIC_URL is http://, the browser won't send a Secure
cookie back, breaking login on lan-http installs. Condition Secure on
the URL protocol so public mode keeps Secure and lan mode drops it.

Closes spec risk: 'Cookie Secure flag on HTTP'."
```

---

## Task 6: Server — TLS health knows about `lan` mode

**Files:**
- Modify: `packages/server/src/services/tls/health.ts`
- Modify: `packages/server/src/index.ts` (probe-skip for lan mode)

In lan mode there's no cert to probe. The `/api/health` response should still report status, but `tls.resolver` becomes `"lan"` with `ok: true` and `daysToExpiry: null`. The migration banner (web UI) keys off `resolver === 'default-fallback'` and must not fire for `lan`.

- [ ] **Step 6.1: Extend the `TlsResolver` enum**

Read `packages/server/src/services/tls/health.ts` lines 11-25 to confirm the current type. Add `"lan"` to the resolver union. Example shape (mirror existing exact names):
```typescript
export type TlsResolver =
  | "public-alpn"
  | "dns-01"
  | "self-ca"
  | "default-fallback"
  | "lan"
  | "unknown";
```

- [ ] **Step 6.2: Update `/api/health` to skip cert probe in lan mode**

In `packages/server/src/index.ts` around line 99-105, replace the existing probe-only-for-non-localhost guard:
```typescript
const domain =
  process.env["AGENTHUB_DOMAIN"] ?? process.env["DOMAIN"] ?? "localhost";
let tls = null;
if (domain !== "localhost") {
  try {
    const { getTlsHealth } = await import("./services/tls/health.js");
    tls = getTlsHealth(domain);
  } catch {}
}
```
with:
```typescript
const domain =
  process.env["AGENTHUB_DOMAIN"] ?? process.env["DOMAIN"] ?? "localhost";
const accessMode = process.env["AGENTHUB_ACCESS_MODE"] ?? "lan";
let tls = null;
if (accessMode === "lan" || domain === "localhost") {
  tls = {
    ok: true,
    domain,
    resolver: "lan" as const,
    issuer: "",
    notBefore: "",
    notAfter: "",
    daysToExpiry: null,
    warnings: [],
  };
} else {
  try {
    const { getTlsHealth } = await import("./services/tls/health.js");
    tls = getTlsHealth(domain);
  } catch {}
}
```

- [ ] **Step 6.3: Allow `daysToExpiry: null` in the `TlsHealth` type**

In `packages/server/src/services/tls/health.ts` line ~17, change `daysToExpiry: number` to `daysToExpiry: number | null`.

- [ ] **Step 6.4: Run typecheck**

Run: `pnpm --filter @agenthub/server exec tsc --noEmit`
Expected: passes.

- [ ] **Step 6.5: Run existing TLS health tests**

Run: `pnpm --filter @agenthub/server exec vitest run`
Expected: all tests pass.

- [ ] **Step 6.6: Commit**

```bash
git add packages/server/src/services/tls/health.ts packages/server/src/index.ts
git commit -m "feat(server): /api/health reports resolver=lan when access mode is lan"
```

---

## Task 7: Server — rename `/api/admin/tls/*` → `/api/admin/access/*`

**Files:**
- Modify: `packages/server/src/routes/admin.ts:484-570`
- Modify: `packages/web/src/lib/api.ts:14-66`
- Modify: `packages/web/src/components/tls/TlsCard.tsx:52`

Hard rename — no alias. Web UI ships in lockstep. (`agenthub reconfigure-tls` CLI alias is handled separately in Task 11.)

- [ ] **Step 7.1: Rename routes in `admin.ts`**

In `packages/server/src/routes/admin.ts`, find the three TLS routes:
- `POST /tls/reconfigure` → `POST /access/reconfigure` (around line 485)
- `POST /tls/renew` → `POST /access/renew` (around line 525)
- `POST /tls/test` → `POST /access/test` (around line 559)

Update the route definition strings only. Body handlers stay the same.

- [ ] **Step 7.2: Update web client calls in `api.ts`**

In `packages/web/src/lib/api.ts`:
- Line 29: `/api/admin/tls/reconfigure` → `/api/admin/access/reconfigure`
- Line 54: `/api/admin/tls/test` → `/api/admin/access/test`

Also rename the comment on line 14 from "Open an SSE stream against /api/admin/tls/reconfigure" to "/api/admin/access/reconfigure".

If the function names are `tlsTest` / `tlsReconfigure`, rename to `accessTest` / `accessReconfigure` and update every caller. To find callers:
```bash
grep -rn "tlsTest\|tlsReconfigure" packages/web/src/
```
Rename each. Same for `streamTlsReconfigure` → `streamAccessReconfigure` if it exists.

- [ ] **Step 7.3: Update `TlsCard.tsx`**

In `packages/web/src/components/tls/TlsCard.tsx:52`: `/api/admin/tls/renew` → `/api/admin/access/renew`.

- [ ] **Step 7.4: Run typecheck across all packages**

Run: `pnpm typecheck`
Expected: passes. If it fails, grep for any remaining `tlsTest`/`tlsReconfigure`/`/api/admin/tls/` references and rename.

- [ ] **Step 7.5: Run the test suite**

Run: `pnpm test`
Expected: all tests pass (including the new `auth.test.ts` from Task 5).

- [ ] **Step 7.6: Commit**

```bash
git add packages/server/src/routes/admin.ts packages/web/src/lib/api.ts packages/web/src/components/tls/TlsCard.tsx
git commit -m "refactor(api): rename /api/admin/tls/* to /api/admin/access/*"
```

---

## Task 8: Installer — `headless.ts` reads `AGENTHUB_ACCESS_MODE` + access-mode-aware probe

**Files:**
- Modify: `packages/installer/src/headless.ts`

The headless install path currently resolves `TlsMode` via `resolveTlsMode` and probes `https://${domain}` after install. Change it to resolve `AccessMode` first (using the new resolver) and probe the right protocol.

- [ ] **Step 8.1: Read `packages/installer/src/headless.ts` lines 34-95 + 110-127**

Note the existing `probeFrontDoor` signature: `probeFrontDoor(domain, resolvedMode)`. It takes a `ResolvedTlsMode`. After this change it'll take an `AccessMode`.

- [ ] **Step 8.2: Replace the imports + signatures**

In `packages/installer/src/headless.ts:9`, replace:
```typescript
import { resolveTlsMode, type ResolvedTlsMode } from "./lib/tls/resolve-mode.js";
```
with:
```typescript
import { resolveAccessMode } from "./lib/access/resolve-mode.js";
import type { AccessMode } from "./lib/access/types.js";
```

Update the `probeFrontDoor` signature (line ~34-36) and `explainAcmeFailure` signature (line ~97):
```typescript
export async function probeFrontDoor(
  domain: string,
  accessMode: AccessMode,
): Promise<{ ok: boolean; ... }> {
```
(Preserve the existing return type — only the second-param type changes.)

```typescript
export function explainAcmeFailure(mode: AccessMode | string): string {
```

- [ ] **Step 8.3: Inside `probeFrontDoor`, use HTTP for lan mode**

Find the curl-probe URL construction (around line 38-68). It currently always uses `https://`. Add a protocol switch:
```typescript
const protocol = accessMode === "lan" ? "http" : "https";
const probeUrl = `${protocol}://${domain}/api/health`;
```
and use `probeUrl` in the curl invocation.

- [ ] **Step 8.4: Skip the cert-validity gate in lan mode**

Find the cert-validity block (around line 72-94). Wrap it:
```typescript
if (accessMode !== "lan") {
  // existing cert-validity gate (probeServingCert call + isTraefikDefault check)
}
```

- [ ] **Step 8.5: Update the resolve call**

Around line 121, replace:
```typescript
const resolvedMode = resolveTlsMode(cfg.tlsMode, cfg.domain, process.env);
```
with:
```typescript
const resolvedAccessMode = resolveAccessMode(cfg.accessMode, cfg.domain, process.env);
```
and replace every downstream use of `resolvedMode` with `resolvedAccessMode`.

The block around line 123-127 that auto-detects LAN IP for self-CA can be removed entirely (self-CA no longer exists).

- [ ] **Step 8.6: Run installer build + tests**

Run: `pnpm --filter @agenthub/installer build && pnpm --filter @agenthub/installer test`
Expected: build succeeds, tests pass.

- [ ] **Step 8.7: Commit**

```bash
git add packages/installer/src/headless.ts
git commit -m "feat(installer): headless reads AGENTHUB_ACCESS_MODE; probe http for lan"
```

---

## Task 9: Installer TUI — replace `tls-strategy` + `tls-self-ca` with `access-mode`

**Files:**
- Modify: `packages/installer/src/app.tsx`

Today's TUI (around lines 14-27, 116-213) walks the user through `domain` → `tls-strategy` → `tls-email`/`tls-self-ca` → ... Replace with `domain` → `access-mode` → (if public) `tls-strategy` → `tls-email` → ... The self-CA step is deleted.

- [ ] **Step 9.1: Update the `Step` union**

In `packages/installer/src/app.tsx:14-27`, replace:
```typescript
type Step = ... | "domain" | "tls-strategy" | "tls-email" | "tls-dns" | "tls-self-ca" | ...
```
with:
```typescript
type Step = ... | "domain" | "access-mode" | "tls-strategy" | "tls-email" | "tls-dns" | ...
```
(Drop `"tls-self-ca"`, add `"access-mode"`.)

- [ ] **Step 9.2: Reroute the `domain` step**

In the `domain` step transition (around line 116-127), change:
```typescript
setStep(next.domain === "localhost" ? "admin" : "tls-strategy");
```
to:
```typescript
setStep(next.domain === "localhost" ? "admin" : "access-mode");
```
(For localhost, `accessMode` defaults to `"lan"` from `emptyConfig`, so jumping straight to `admin` is correct.)

- [ ] **Step 9.3: Add the new `access-mode` step**

Insert a new step handler before the existing `tls-strategy` block (around line 128). Use Ink's `SelectInput`:
```tsx
if (step === "access-mode") {
  return (
    <Box flexDirection="column">
      <Text bold>How will you access this install?</Text>
      <Text dimColor>The default is "LAN only" — zero TLS setup.</Text>
      <SelectInput
        items={[
          { label: "I'll only access from my LAN (no TLS setup)", value: "lan" },
          { label: "I want my host directly reachable on the public internet (Let's Encrypt)", value: "public" },
        ]}
        onSelect={(item) => {
          setConfig((c) => ({ ...c, accessMode: item.value as AccessMode }));
          setStep(item.value === "lan" ? "admin" : "tls-strategy");
        }}
      />
    </Box>
  );
}
```
(Import `AccessMode` from `./lib/access/types.js` at the top.)

- [ ] **Step 9.4: Delete the `tls-self-ca` step**

Remove the entire `if (step === "tls-self-ca") { ... }` block (around lines 203-213) and any references that route to it.

In the `tls-strategy` block (around lines 129-165), find the line `setStep("tls-self-ca");` and remove that branch. Self-CA is gone — the menu loses one option.

- [ ] **Step 9.5: Run the installer build**

Run: `pnpm --filter @agenthub/installer build`
Expected: build succeeds.

- [ ] **Step 9.6: Manual smoke run (no commit)**

Run: `node packages/installer/dist/index.js --help` (or equivalent) to confirm the binary executes without crashing on the new state machine. Don't actually run the install.

- [ ] **Step 9.7: Commit**

```bash
git add packages/installer/src/app.tsx
git commit -m "feat(installer): TUI gains access-mode step; self-CA step removed"
```

---

## Task 10: Installer — `renderEnv` emits `AGENTHUB_ACCESS_MODE` + `AGENTHUB_PUBLIC_URL`

**Files:**
- Modify: `packages/installer/src/lib/config.ts:101-164` (renderEnv)

The server needs `AGENTHUB_ACCESS_MODE` and `AGENTHUB_PUBLIC_URL` in `.env`. Today neither is emitted.

- [ ] **Step 10.1: Update `renderEnv` to emit the new vars**

In `packages/installer/src/lib/config.ts:101-164`, inside `renderEnv`, change the `COMPOSE_FILE` logic to be access-mode-aware:
```typescript
// COMPOSE_FILE: include the override only when we generated one (public mode).
const composeFile =
  cfg.accessMode === "public"
    ? "COMPOSE_FILE=docker-compose.yml:traefik.override.yml"
    : null;
```
Then in the returned array, replace:
```typescript
...(cfg.domain === "localhost"
  ? []
  : ["COMPOSE_FILE=docker-compose.yml:traefik.override.yml"]),
```
with:
```typescript
...(composeFile ? [composeFile] : []),
```

Add two new lines after `DOMAIN=${cfg.domain}`:
```typescript
`AGENTHUB_ACCESS_MODE=${cfg.accessMode}`,
`AGENTHUB_PUBLIC_URL=${cfg.accessMode === "public" ? "https" : "http"}://${cfg.domain}`,
```

- [ ] **Step 10.2: Add tests for renderEnv**

Create `packages/installer/src/lib/config.test.ts` (or append to existing if any):
```typescript
import { describe, it, expect } from "vitest";
import { emptyConfig, renderEnv } from "./config.js";

describe("renderEnv", () => {
  it("lan mode: PUBLIC_URL is http; no COMPOSE_FILE override", () => {
    const env = renderEnv({ ...emptyConfig(), accessMode: "lan", domain: "192.168.1.5" });
    expect(env).toContain("AGENTHUB_ACCESS_MODE=lan");
    expect(env).toContain("AGENTHUB_PUBLIC_URL=http://192.168.1.5");
    expect(env).not.toContain("COMPOSE_FILE=");
  });

  it("public mode: PUBLIC_URL is https; COMPOSE_FILE includes override", () => {
    const env = renderEnv({
      ...emptyConfig(),
      accessMode: "public",
      domain: "agenthub.example.com",
    });
    expect(env).toContain("AGENTHUB_ACCESS_MODE=public");
    expect(env).toContain("AGENTHUB_PUBLIC_URL=https://agenthub.example.com");
    expect(env).toContain("COMPOSE_FILE=docker-compose.yml:traefik.override.yml");
  });

  it("localhost still maps to lan", () => {
    const env = renderEnv({ ...emptyConfig(), accessMode: "lan", domain: "localhost" });
    expect(env).toContain("AGENTHUB_PUBLIC_URL=http://localhost");
  });
});
```

- [ ] **Step 10.3: Run the tests**

Run: `pnpm --filter @agenthub/installer exec vitest run src/lib/config.test.ts`
Expected: 3 tests pass.

- [ ] **Step 10.4: Commit**

```bash
git add packages/installer/src/lib/config.ts packages/installer/src/lib/config.test.ts
git commit -m "feat(installer): renderEnv emits AGENTHUB_ACCESS_MODE + AGENTHUB_PUBLIC_URL"
```

---

## Task 11: Reconfigure — `agenthub reconfigure-access` + alias

**Files:**
- Modify: `packages/installer/src/reconfigure.ts`
- Modify: `packages/installer/src/reconfigure-app.tsx`
- Modify: `packages/installer/src/reconfigure-cli.ts`
- Modify: `scripts/agenthub:506-514`

- [ ] **Step 11.1: Read `packages/installer/src/reconfigure-cli.ts`**

Note the `--non-interactive`, `--no-rollback`, `--regen-cert` flags. `--regen-cert` is self-CA-only and gets deleted.

- [ ] **Step 11.2: Drop self-CA from `reconfigure-app.tsx`**

In `packages/installer/src/reconfigure-app.tsx`, find the `Step` union (around line 35):
```typescript
type Step = "strategy" | "email" | "dns-token" | "self-ca-ip" | "running" | "done";
```
Change to:
```typescript
type Step = "access-mode" | "tls-strategy" | "email" | "dns-token" | "running" | "done";
```

Replace the existing top-level menu with the access-mode chooser (mirroring app.tsx Task 9.3). After "public" is picked, transition to `tls-strategy` (the public-alpn vs dns-01 menu). After "lan" is picked, transition straight to `running` (apply and probe).

Delete the `"self-ca-ip"` step handler.

- [ ] **Step 11.3: Update `reconfigure.ts` to take `AccessMode`**

In `packages/installer/src/reconfigure.ts`, change `ReconfigureConfig` (around L18-25) from `mode: TlsMode` to `accessMode: AccessMode; publicTlsMode?: PublicTlsMode`. Update `runReconfigure` to:
1. Call `renderTraefikStaticConfig` (new) instead of the old `renderTraefikConfig`.
2. Call `renderTraefikOverride` (new) — null in lan mode means no override file.
3. Call `renderRedirectDynamic` — null in lan mode means delete the existing redirect.yml if present.
4. Probe `http://` for lan, `https://` for public.

Snapshot/rollback behavior stays unchanged.

- [ ] **Step 11.4: Remove `--regen-cert` flag from `reconfigure-cli.ts`**

Self-CA is gone. Delete the `--regen-cert` arg parsing and the env var (`REGEN=1`) that triggers self-CA init regeneration.

- [ ] **Step 11.5: Add `reconfigure-access` verb to `scripts/agenthub`**

In `scripts/agenthub` around line 506-514, find the `reconfigure-tls)` case in the verb dispatch. Add a new `reconfigure-access)` case that does the same thing (calls the same `reconfigure-cli.js`). Update the `reconfigure-tls)` case to print a deprecation warning before delegating:
```bash
reconfigure-access)
  exec node "$AGENTHUB_DIR/packages/installer/dist/reconfigure-cli.js" "$@"
  ;;
reconfigure-tls)
  warn "'agenthub reconfigure-tls' is deprecated; use 'agenthub reconfigure-access'"
  exec node "$AGENTHUB_DIR/packages/installer/dist/reconfigure-cli.js" "$@"
  ;;
```

Also update the `usage()` text in `scripts/agenthub` (find with `grep -n 'usage()' scripts/agenthub`) to list `reconfigure-access` and mention the `reconfigure-tls` alias.

- [ ] **Step 11.6: Run the installer build**

Run: `pnpm --filter @agenthub/installer build`
Expected: build succeeds. Run `node packages/installer/dist/reconfigure-cli.js --help` to confirm.

- [ ] **Step 11.7: Lint shellcheck the agenthub script**

Run: `shellcheck scripts/agenthub`
Expected: no new warnings beyond existing baseline. Fix any introduced by the edits.

- [ ] **Step 11.8: Commit**

```bash
git add packages/installer/src/reconfigure.ts packages/installer/src/reconfigure-app.tsx packages/installer/src/reconfigure-cli.ts scripts/agenthub
git commit -m "feat(reconfigure): add reconfigure-access verb; keep reconfigure-tls as deprecated alias"
```

---

## Task 12: Migration — self-CA → lan, public-alpn/dns-01 → public

**Files:**
- Create: `packages/installer/src/lib/access/migrate.ts`
- Create: `packages/installer/src/lib/access/migrate.test.ts`
- Create: `packages/installer/src/lib/access/migrate-cli.ts`
- Modify: `scripts/agenthub:316-340` (`migrate_env` function)

The new `migrate.ts` REPLACES `packages/installer/src/lib/tls/migrate.ts`. It reads the install's `.env`, infers the legacy mode, rewrites `.env` + regenerates `traefik.yml` + cleans up old override entries. The CLI is invoked by `agenthub update`.

- [ ] **Step 12.1: Write the failing tests**

Create `packages/installer/src/lib/access/migrate.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { migrateAccessConfig } from "./migrate.js";

function setupFixture(envContents: string, overrideContents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "migrate-access-"));
  writeFileSync(join(dir, ".env"), envContents);
  if (overrideContents !== undefined) {
    writeFileSync(join(dir, "traefik.override.yml"), overrideContents);
  }
  return dir;
}

describe("migrateAccessConfig", () => {
  it("self-ca → lan: rewrites .env, deletes self-CA artifacts from override", () => {
    const dir = setupFixture(
      [
        "DOMAIN=agenthub.example.com",
        "AGENTHUB_TLS_MODE=self-ca",
        "AGENTHUB_LAN_IP=192.168.1.5",
        "COMPOSE_FILE=docker-compose.yml:traefik.override.yml",
      ].join("\n"),
      "services:\n  traefik-self-ca-init:\n    image: alpine:3.20\n",
    );
    const r = migrateAccessConfig(dir);
    expect(r.action).toBe("migrated-self-ca-to-lan");
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("AGENTHUB_ACCESS_MODE=lan");
    expect(env).toContain("AGENTHUB_PUBLIC_URL=http://agenthub.example.com");
    expect(env).not.toMatch(/AGENTHUB_TLS_MODE=self-ca/);
    expect(env).not.toMatch(/COMPOSE_FILE=.*traefik\.override\.yml/);
    expect(existsSync(join(dir, "traefik.override.yml"))).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it("public-alpn → public+public-alpn: keeps tlsMode as sub-mode", () => {
    const dir = setupFixture(
      [
        "DOMAIN=agenthub.example.com",
        "AGENTHUB_TLS_MODE=public-alpn",
        "AGENTHUB_TLS_EMAIL=ops@example.com",
        "COMPOSE_FILE=docker-compose.yml:traefik.override.yml",
      ].join("\n"),
    );
    const r = migrateAccessConfig(dir);
    expect(r.action).toBe("migrated-tls-to-public");
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("AGENTHUB_ACCESS_MODE=public");
    expect(env).toContain("AGENTHUB_TLS_MODE=public-alpn");
    expect(env).toContain("AGENTHUB_PUBLIC_URL=https://agenthub.example.com");
    rmSync(dir, { recursive: true });
  });

  it("dns-01 → public+dns-01: preserves DNS provider env vars", () => {
    const dir = setupFixture(
      [
        "DOMAIN=agenthub.example.com",
        "AGENTHUB_TLS_MODE=dns-01",
        "AGENTHUB_TLS_DNS_PROVIDER=cloudflare",
        "AGENTHUB_TLS_EMAIL=ops@example.com",
        "CF_DNS_API_TOKEN=secret",
      ].join("\n"),
    );
    const r = migrateAccessConfig(dir);
    expect(r.action).toBe("migrated-tls-to-public");
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("AGENTHUB_ACCESS_MODE=public");
    expect(env).toContain("AGENTHUB_TLS_MODE=dns-01");
    expect(env).toContain("CF_DNS_API_TOKEN=secret");
    rmSync(dir, { recursive: true });
  });

  it("DOMAIN=localhost: rewrites to lan", () => {
    const dir = setupFixture(
      ["DOMAIN=localhost", "AGENTHUB_TLS_MODE=auto"].join("\n"),
    );
    const r = migrateAccessConfig(dir);
    expect(r.action).toBe("migrated-localhost-to-lan");
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("AGENTHUB_ACCESS_MODE=lan");
    expect(env).toContain("AGENTHUB_PUBLIC_URL=http://localhost");
    rmSync(dir, { recursive: true });
  });

  it("already migrated: noop", () => {
    const dir = setupFixture(
      [
        "DOMAIN=agenthub.example.com",
        "AGENTHUB_ACCESS_MODE=lan",
        "AGENTHUB_PUBLIC_URL=http://agenthub.example.com",
      ].join("\n"),
    );
    const r = migrateAccessConfig(dir);
    expect(r.action).toBe("noop-already-migrated");
    rmSync(dir, { recursive: true });
  });

  it("self-ca migration warning includes HSTS hint", () => {
    const dir = setupFixture(
      [
        "DOMAIN=agenthub.example.com",
        "AGENTHUB_TLS_MODE=self-ca",
        "AGENTHUB_LAN_IP=192.168.1.5",
      ].join("\n"),
    );
    const r = migrateAccessConfig(dir);
    expect(r.warnings.some((w) => w.includes("HSTS"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("chrome://net-internals/#hsts"))).toBe(true);
    rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 12.2: Run the failing tests**

Run: `pnpm --filter @agenthub/installer exec vitest run src/lib/access/migrate.test.ts`
Expected: fails — `migrate.ts` not yet created.

- [ ] **Step 12.3: Implement `migrate.ts`**

Create `packages/installer/src/lib/access/migrate.ts`:
```typescript
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";

export interface MigrateResult {
  action:
    | "noop-already-migrated"
    | "migrated-self-ca-to-lan"
    | "migrated-tls-to-public"
    | "migrated-localhost-to-lan";
  warnings: string[];
}

const HSTS_WARNING =
  "Browsers that visited the previous self-CA HTTPS install may be HSTS-pinned and refuse plain HTTP. " +
  "Operators must clear chrome://net-internals/#hsts (Chrome) or use 'Forget About This Site' (Firefox) " +
  "for this domain to reach the new lan-http install.";

function parseDotEnv(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    m.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return m;
}

function renderDotEnv(env: Map<string, string>): string {
  return Array.from(env.entries()).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

export function migrateAccessConfig(composeDir: string): MigrateResult {
  const envPath = join(composeDir, ".env");
  if (!existsSync(envPath)) {
    return { action: "noop-already-migrated", warnings: [] };
  }
  const env = parseDotEnv(readFileSync(envPath, "utf8"));
  const warnings: string[] = [];

  // Already-migrated short-circuit
  if (env.has("AGENTHUB_ACCESS_MODE")) {
    return { action: "noop-already-migrated", warnings: [] };
  }

  const domain = env.get("DOMAIN") ?? "localhost";
  const oldMode = env.get("AGENTHUB_TLS_MODE") ?? "auto";

  // Localhost → lan
  if (domain === "localhost") {
    env.set("AGENTHUB_ACCESS_MODE", "lan");
    env.set("AGENTHUB_PUBLIC_URL", "http://localhost");
    env.delete("AGENTHUB_TLS_MODE");
    env.delete("COMPOSE_FILE");
    writeFileSync(envPath, renderDotEnv(env));
    return { action: "migrated-localhost-to-lan", warnings };
  }

  // self-ca → lan
  if (oldMode === "self-ca") {
    env.set("AGENTHUB_ACCESS_MODE", "lan");
    env.set("AGENTHUB_PUBLIC_URL", `http://${domain}`);
    env.delete("AGENTHUB_TLS_MODE");
    env.delete("AGENTHUB_LAN_IP");
    env.delete("COMPOSE_FILE");
    writeFileSync(envPath, renderDotEnv(env));
    // Delete the self-CA override file; the base compose is now sufficient.
    const overridePath = join(composeDir, "traefik.override.yml");
    if (existsSync(overridePath)) unlinkSync(overridePath);
    warnings.push(HSTS_WARNING);
    return { action: "migrated-self-ca-to-lan", warnings };
  }

  // public-alpn / dns-01 → public + sub-mode
  if (oldMode === "public-alpn" || oldMode === "dns-01") {
    env.set("AGENTHUB_ACCESS_MODE", "public");
    env.set("AGENTHUB_PUBLIC_URL", `https://${domain}`);
    // Keep AGENTHUB_TLS_MODE as the sub-mode.
    writeFileSync(envPath, renderDotEnv(env));
    return { action: "migrated-tls-to-public", warnings };
  }

  // auto on a real domain: pick public-alpn unless a DNS provider is set.
  if (oldMode === "auto") {
    env.set("AGENTHUB_ACCESS_MODE", "public");
    env.set("AGENTHUB_PUBLIC_URL", `https://${domain}`);
    env.set(
      "AGENTHUB_TLS_MODE",
      env.has("AGENTHUB_TLS_DNS_PROVIDER") ? "dns-01" : "public-alpn",
    );
    writeFileSync(envPath, renderDotEnv(env));
    return { action: "migrated-tls-to-public", warnings };
  }

  // Unknown mode: leave alone but warn. Defensive.
  warnings.push(`Unknown AGENTHUB_TLS_MODE='${oldMode}'; manual migration required.`);
  return { action: "noop-already-migrated", warnings };
}
```

- [ ] **Step 12.4: Run the tests (passing)**

Run: `pnpm --filter @agenthub/installer exec vitest run src/lib/access/migrate.test.ts`
Expected: 6 tests pass.

- [ ] **Step 12.5: Implement the CLI wrapper**

Create `packages/installer/src/lib/access/migrate-cli.ts`:
```typescript
#!/usr/bin/env node
import { migrateAccessConfig } from "./migrate.js";

function main(): void {
  const composeDir = process.argv[2];
  if (!composeDir) {
    console.error("usage: migrate-cli.js <composeDir>");
    process.exit(2);
  }
  try {
    const r = migrateAccessConfig(composeDir);
    console.log(`[migrate-access] ${r.action}`);
    for (const w of r.warnings) {
      console.warn(`[migrate-access] WARN: ${w}`);
    }
  } catch (err) {
    console.error(
      "[migrate-access] failed:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }
}

main();
```

- [ ] **Step 12.6: Wire the new CLI into `scripts/agenthub:316-340`**

In `scripts/agenthub`, find `migrate_env()` (around line 316). Change the path:
```bash
local migrate_cli="$AGENTHUB_DIR/packages/installer/dist/lib/tls/migrate-cli.js"
```
to:
```bash
local migrate_cli="$AGENTHUB_DIR/packages/installer/dist/lib/access/migrate-cli.js"
```

Also update the warning message string on line 326 from "migrate-tls CLI generates" to "migrate-access CLI generates" and line 333 from "migrate-cli.js not built yet; skipping TLS migration" to "skipping access migration".

- [ ] **Step 12.7: Run the installer build + tests**

Run: `pnpm --filter @agenthub/installer build && pnpm --filter @agenthub/installer test`
Expected: build + tests pass.

- [ ] **Step 12.8: Lint shellcheck**

Run: `shellcheck scripts/agenthub`
Expected: no new warnings.

- [ ] **Step 12.9: Commit**

```bash
git add packages/installer/src/lib/access/migrate.ts packages/installer/src/lib/access/migrate.test.ts packages/installer/src/lib/access/migrate-cli.ts scripts/agenthub
git commit -m "feat(migrate): self-CA → lan, public-alpn/dns-01 → public (with HSTS warning)"
```

---

## Task 13: Web UI — rename `TlsCard` → `AccessCard` + render lan state

**Files:**
- Rename: `packages/web/src/components/tls/TlsCard.tsx` → `packages/web/src/components/access/AccessCard.tsx`
- Modify: `packages/web/src/pages/Settings.tsx:84`

- [ ] **Step 13.1: Create the new components directory + move the file**

```bash
mkdir -p packages/web/src/components/access
git mv packages/web/src/components/tls/TlsCard.tsx packages/web/src/components/access/AccessCard.tsx
```

- [ ] **Step 13.2: Rename the component class + handle the new `lan` resolver**

In `packages/web/src/components/access/AccessCard.tsx`, rename the exported `TlsCard` symbol to `AccessCard`. Update the JSX it renders based on resolver:
- `resolver === "lan"`: show "LAN-only access — no TLS, http://${domain}" with no expiry / no renew button.
- `resolver === "default-fallback"`: existing warning UI.
- `resolver === "public-alpn"` or `"dns-01"`: existing cert-status UI.

Concretely add a branch near the top of the render:
```tsx
if (tls.resolver === "lan") {
  return (
    <Card title="Access">
      <p className="text-sm">
        LAN-only access via <code>http://{tls.domain}</code>. No TLS configured.
      </p>
      <Button onClick={() => setReconfigureOpen(true)}>Switch mode</Button>
    </Card>
  );
}
```
(Match the existing Card / Button / styling conventions in the file — read the surrounding code for the exact components used.)

- [ ] **Step 13.3: Update the import in `Settings.tsx`**

In `packages/web/src/pages/Settings.tsx:84` (where TlsCard is mounted), update the import from `../components/tls/TlsCard` to `../components/access/AccessCard` and the component reference from `<TlsCard />` to `<AccessCard />`.

- [ ] **Step 13.4: Find any other importers**

```bash
grep -rn "from.*components/tls/TlsCard\|from.*TlsCard" packages/web/src
```
Update each.

- [ ] **Step 13.5: Run web build + typecheck**

Run: `pnpm --filter @agenthub/web build && pnpm --filter @agenthub/web exec tsc --noEmit`
Expected: build + typecheck pass.

- [ ] **Step 13.6: Commit**

```bash
git add packages/web/src/components/access/AccessCard.tsx packages/web/src/pages/Settings.tsx
git rm packages/web/src/components/tls/TlsCard.tsx 2>/dev/null || true
git commit -m "feat(web): TlsCard → AccessCard; render lan-only state"
```

---

## Task 14: Web UI — rename ReconfigureTlsModal + MigrationBanner

**Files:**
- Rename: `packages/web/src/components/tls/ReconfigureTlsModal.tsx` → `packages/web/src/components/access/ReconfigureAccessModal.tsx`
- Rename: `packages/web/src/components/tls/MigrationBanner.tsx` → `packages/web/src/components/access/MigrationBanner.tsx`
- Modify: `packages/web/src/App.tsx` (mount path)

- [ ] **Step 14.1: Move the files**

```bash
git mv packages/web/src/components/tls/ReconfigureTlsModal.tsx packages/web/src/components/access/ReconfigureAccessModal.tsx
git mv packages/web/src/components/tls/MigrationBanner.tsx packages/web/src/components/access/MigrationBanner.tsx
```

- [ ] **Step 14.2: Rename the modal component + add access-mode chooser**

In `packages/web/src/components/access/ReconfigureAccessModal.tsx`, rename the exported component to `ReconfigureAccessModal`. Restructure the wizard to start with the access-mode chooser (`lan` vs `public`), then for public → existing TLS strategy chooser (public-alpn vs dns-01) → email → DNS token (if dns-01).

Drop the self-CA branch entirely. Drop the self-CA LAN-IP prompt.

- [ ] **Step 14.3: Update MigrationBanner copy**

In `packages/web/src/components/access/MigrationBanner.tsx`, the banner currently fires when `resolver === "default-fallback"`. Keep this behavior — but update the message body to mention the new `agenthub reconfigure-access` verb instead of `reconfigure-tls`.

Add no special case for `resolver === "lan"` — that's the intended state and shouldn't trigger any banner.

- [ ] **Step 14.4: Update App.tsx**

In `packages/web/src/App.tsx` (line 14 import, line 18 mount), change:
- Import path: `./components/tls/MigrationBanner` → `./components/access/MigrationBanner`

Also update the AccessCard import path (from Task 13.3 if not already) and the ReconfigureAccessModal usage in AccessCard (component name + import path).

- [ ] **Step 14.5: Find any remaining importers**

```bash
grep -rn "components/tls\|ReconfigureTlsModal\|TlsCard" packages/web/src
```
Update each. Delete the now-empty `packages/web/src/components/tls/` directory:
```bash
rmdir packages/web/src/components/tls/ 2>/dev/null || true
```

- [ ] **Step 14.6: Run web build**

Run: `pnpm --filter @agenthub/web build`
Expected: build succeeds.

- [ ] **Step 14.7: Commit**

```bash
git add packages/web/src/components/access/ packages/web/src/App.tsx
git rm -r packages/web/src/components/tls/ 2>/dev/null || true
git commit -m "feat(web): rename ReconfigureTlsModal + MigrationBanner under components/access/"
```

---

## Task 15: Server — `agenthub status` shows access mode line

**Files:**
- Modify: `scripts/agenthub:80-130`

- [ ] **Step 15.1: Read the current status output**

In `scripts/agenthub`, find the `status)` block (around line 80-130). It currently fetches `/api/health` and prints a TLS line. Modify it to:
- If `tls.resolver === "lan"`: print "Access: LAN (http://${DOMAIN})"
- Else: print existing "TLS: ${resolver}, expires in ${daysToExpiry} days" line

- [ ] **Step 15.2: Apply the change**

In the existing TLS-line block, switch on the resolver field (currently parsed via `jq`). Pseudo-bash (verify exact jq query against the existing code):
```bash
resolver=$(echo "$health" | jq -r '.tls.resolver // "unknown"')
case "$resolver" in
  lan)
    echo "Access: LAN (http://$(echo "$health" | jq -r '.tls.domain'))"
    ;;
  default-fallback)
    echo "TLS: FAILING (Traefik serving default cert). Run 'agenthub reconfigure-access'."
    ;;
  *)
    days=$(echo "$health" | jq -r '.tls.daysToExpiry')
    echo "TLS: $resolver, expires in $days days"
    ;;
esac
```

(Match the existing style + variable names; don't introduce new helpers.)

- [ ] **Step 15.3: Lint shellcheck**

Run: `shellcheck scripts/agenthub`
Expected: no new warnings.

- [ ] **Step 15.4: Commit**

```bash
git add scripts/agenthub
git commit -m "feat(agenthub): status verb shows access mode for lan installs"
```

---

## Task 16: Delete self-CA artifacts + now-unused TLS lib files

**Files (deletion):**
- `scripts/self-ca-init.sh`
- `scripts/self-ca-renew.sh`
- `compose/static/install-ca/` (whole directory)
- `packages/installer/src/lib/tls/resolve-mode.ts` + `resolve-mode.test.ts`
- `packages/installer/src/lib/tls/render-override.ts` + `render-override.test.ts`
- `packages/installer/src/lib/tls/render-traefik-config.ts` + tests if any
- `packages/installer/src/lib/tls/render-dynamic-config.ts` + tests if any
- `packages/installer/src/lib/tls/migrate.ts` + `migrate.test.ts` + `migrate-cli.ts`
- `packages/installer/src/lib/tls/lan-ip.ts` + `lan-ip.test.ts`

- [ ] **Step 16.1: Confirm nothing else imports the deletables**

```bash
grep -rn "lib/tls/resolve-mode\|lib/tls/render-override\|lib/tls/render-traefik\|lib/tls/render-dynamic\|lib/tls/migrate\|lib/tls/lan-ip" packages/
```
Expected: no matches (Task 8 already updated `headless.ts`; Task 12 updated `agenthub`).

If any matches found, update those importers to point at the new `lib/access/` equivalents before deleting.

- [ ] **Step 16.2: Delete the files**

```bash
git rm scripts/self-ca-init.sh scripts/self-ca-renew.sh
git rm -r compose/static/install-ca/
git rm packages/installer/src/lib/tls/resolve-mode.ts packages/installer/src/lib/tls/resolve-mode.test.ts
git rm packages/installer/src/lib/tls/render-override.ts packages/installer/src/lib/tls/render-override.test.ts
git rm packages/installer/src/lib/tls/render-traefik-config.ts 2>/dev/null
git rm packages/installer/src/lib/tls/render-dynamic-config.ts 2>/dev/null
git rm packages/installer/src/lib/tls/render-traefik-config.test.ts 2>/dev/null
git rm packages/installer/src/lib/tls/render-dynamic-config.test.ts 2>/dev/null
git rm packages/installer/src/lib/tls/migrate.ts packages/installer/src/lib/tls/migrate.test.ts packages/installer/src/lib/tls/migrate-cli.ts
git rm packages/installer/src/lib/tls/lan-ip.ts 2>/dev/null
git rm packages/installer/src/lib/tls/lan-ip.test.ts 2>/dev/null
```

- [ ] **Step 16.3: Run full test suite**

Run: `pnpm test`
Expected: all remaining tests pass (no broken imports from the deletions).

- [ ] **Step 16.4: Run typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 16.5: Commit**

```bash
git commit -m "chore: delete self-CA scripts + obsolete lib/tls/ render+migrate modules"
```

---

## Task 17: Docs — rewrite `tls-modes.md` as `access-modes.md`; update agents/humans

**Files:**
- Delete: `docs/install/tls-modes.md`
- Create: `docs/install/access-modes.md`
- Modify: `docs/install/agents.md`
- Modify: `docs/install/humans.md`

- [ ] **Step 17.1: Move + rewrite the modes doc**

```bash
git mv docs/install/tls-modes.md docs/install/access-modes.md
```

Rewrite the contents of `docs/install/access-modes.md` to describe two modes:
- **lan-http (default)**: zero TLS setup, accessible via `http://<host>` on the LAN. No env vars required. This is the right choice for ~99% of self-hosted installs.
- **public**: Let's Encrypt-issued certs, host directly reachable on the public internet. Two sub-modes:
  - `public-alpn`: host's :443 must be reachable from outside (port forwarding / public IP).
  - `dns-01`: host stays internal; LE proves ownership via DNS TXT records. Requires a DNS provider API token (Cloudflare is first-class; ~80 others supported via lego env vars).

Include the env var contract from the spec (`AGENTHUB_ACCESS_MODE`, `AGENTHUB_TLS_MODE`, `AGENTHUB_TLS_EMAIL`, `AGENTHUB_TLS_DNS_PROVIDER`).

Mention that `tunnel` mode (Cloudflare Tunnel) is coming in a follow-up.

Add a "Migration from self-CA" section noting the HSTS clearance step.

- [ ] **Step 17.2: Update `docs/install/agents.md` env-vars table**

In `docs/install/agents.md` (find with `grep -n 'TLS_MODE\|TLS_DNS\|TLS_EMAIL' docs/install/agents.md`), replace the TLS env vars section:
- Add `AGENTHUB_ACCESS_MODE` (`lan` default, `public`).
- Keep `AGENTHUB_TLS_MODE` but mark it "only relevant when `ACCESS_MODE=public`".
- Keep `AGENTHUB_TLS_EMAIL` and `AGENTHUB_TLS_DNS_PROVIDER` with "required when `ACCESS_MODE=public`" notes.
- Remove any mention of `self-ca` and `AGENTHUB_LAN_IP`.

- [ ] **Step 17.3: Update `docs/install/humans.md`**

In `docs/install/humans.md`, find section "4. TLS email" (header `## 4. TLS email`). Update to "4. Access mode" — explain the lan vs public choice. The TLS email prompt moves into the public-mode branch.

- [ ] **Step 17.4: Update `CLAUDE.md` TLS section**

In `CLAUDE.md`, find the "### TLS strategy surface" section. Rewrite to reflect the new contract. Mention:
- Two modes today: `lan` (default), `public` (sub-modes `public-alpn` / `dns-01`).
- Tunnel deferred to follow-up.
- Self-CA is gone.
- Migration handles old installs automatically on `agenthub update`.
- HSTS gotcha for browsers that hit the old HTTPS install pre-PR-#74.

(Keep this section concise — ~30 lines. The full design is in the merged spec.)

- [ ] **Step 17.5: Commit**

```bash
git add docs/install/access-modes.md docs/install/agents.md docs/install/humans.md CLAUDE.md
git rm docs/install/tls-modes.md 2>/dev/null || true
git commit -m "docs: rewrite tls-modes as access-modes; refresh CLAUDE.md TLS section"
```

---

## Task 18: E2E — `lan-http` happy path in `scripts/e2e-full.js`

**Files:**
- Modify: `scripts/e2e-full.js`

- [ ] **Step 18.1: Read the existing test structure**

Run: `grep -n 'test\|describe\|it(\|async function' scripts/e2e-full.js | head -30`
Note the test framework used (custom assertions vs node:test vs tap).

- [ ] **Step 18.2: Add a `lan-http` smoke test**

Append a new test step to `scripts/e2e-full.js` that:
1. Reads `process.env.PUBLIC_URL` (set by the install script).
2. If it starts with `http://`, makes a plain HTTP GET to `${PUBLIC_URL}/api/health` and asserts status 200 with body containing `"resolver":"lan"`.
3. Performs login via `POST /api/auth/login` over HTTP and asserts the response sets `session_token` cookie WITHOUT the `Secure` attribute (parse the `Set-Cookie` header).
4. Opens a ttyd WS connection over `ws://` and asserts it accepts the connection.

The exact API:
```javascript
async function testLanHttp(baseUrl) {
  // 1. Health endpoint reports resolver=lan
  const health = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
  if (health.tls?.resolver !== "lan") {
    throw new Error(`expected tls.resolver=lan, got ${health.tls?.resolver}`);
  }

  // 2. Login over plain HTTP and inspect Set-Cookie
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
  });
  const setCookie = loginRes.headers.get("set-cookie") ?? "";
  if (!setCookie.includes("session_token=")) {
    throw new Error("login did not set session_token cookie");
  }
  if (setCookie.toLowerCase().includes("secure")) {
    throw new Error("lan-http login set Secure cookie; would break HTTP browsers");
  }

  console.log("[e2e] lan-http: health + login + cookie attributes OK");
}
```

Wire `testLanHttp` into the test runner so it executes only when `PUBLIC_URL` starts with `http://`.

- [ ] **Step 18.3: Sanity-run the e2e script syntax**

Run: `node --check scripts/e2e-full.js`
Expected: no syntax errors.

(Don't run the full e2e here — that requires a fresh VM. The manual VM verify happens in the "Post-implementation" section below.)

- [ ] **Step 18.4: Commit**

```bash
git add scripts/e2e-full.js
git commit -m "test(e2e): add lan-http health + login + cookie attribute smoke"
```

---

## Task 19: Final sweep + open PR

- [ ] **Step 19.1: Run full test suite**

Run: `pnpm test`
Expected: all tests pass. Note the count vs the baseline from Step 0.3.

- [ ] **Step 19.2: Run typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 19.3: Run lint**

Run: `pnpm lint`
Expected: passes (where configured).

- [ ] **Step 19.4: Sanity-grep for leftover self-CA references**

```bash
grep -rn "self-ca\|self_ca\|self-CA" packages/ scripts/ compose/ docs/ 2>/dev/null | grep -v "docs/superpowers/specs\|docs/superpowers/plans\|memory/" | head -20
```
Expected: empty or only comments mentioning the deletion. Any code references = bug, go fix.

- [ ] **Step 19.5: Sanity-grep for leftover `tlsMode`**

```bash
grep -rn "tlsMode" packages/installer/src packages/web/src 2>/dev/null | head -20
```
Expected: only references inside the migration code (reading legacy values) and the public-mode sub-mode chooser. No top-level usage as "the install's mode."

- [ ] **Step 19.6: Open the PR**

```bash
git push -u origin feat/lan-first-tls-impl
gh pr create --title "feat(access): LAN-first TLS — kill self-CA, default to HTTP-on-LAN" --body "$(cat <<'EOF'
## Summary

Implements `docs/superpowers/specs/2026-05-13-lan-first-tls-default.md` (PR #73).

Replaces the 4-mode TLS surface with a 2-mode access surface:

- **lan** (new default) — HTTP on :80, no TLS, no cert ceremony.
- **public** — Let's Encrypt; sub-modes `public-alpn` and `dns-01` unchanged.

Self-CA is deleted entirely. Tunnel mode is deferred to a follow-up PR.

## What's in this PR

- New `packages/installer/src/lib/access/` module (types, resolver, renderer, migration).
- Base compose moves `:443` and `websecure` to a public-mode-only override.
- Server cookie `Secure` flag now keys off `AGENTHUB_PUBLIC_URL` protocol — fixes login over HTTP in lan mode.
- `/api/admin/tls/*` renamed to `/api/admin/access/*`.
- `agenthub reconfigure-access` verb (keeps `reconfigure-tls` as a deprecated alias).
- Web UI: `TlsCard` → `AccessCard`, new lan-state rendering.
- Migration: existing self-CA installs auto-migrate to lan on next `agenthub update`. Migration log surfaces the HSTS clearance hint.
- Self-CA scripts, install-ca static page, and now-unused TLS lib modules deleted.
- E2E test: lan-http health + login + cookie attributes.

## Test plan

- [ ] `pnpm test` passes
- [ ] `pnpm typecheck` passes
- [ ] Manual VM: clone Proxmox 9000 → 924+, install with no TLS env vars, confirm `http://<vm-ip>` works end-to-end (login, sessions, ttyd)
- [ ] Manual VM 923: `sudo agenthub update`, confirm migration from self-CA → lan, browser HSTS cleared per banner message

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 19.7: Verify CI**

Run: `gh pr checks` (after CI kicks in).
Expected: all checks green. Investigate any failures.

---

## Post-implementation (out of plan scope; for the operator)

After the PR merges:

1. **VM 924 fresh install verify**: clone Proxmox 9000 → 924, run the one-line install with no TLS env vars. Confirm `http://<vm-ip>` works from a LAN browser.

2. **VM 923 migration verify**: `sudo /usr/local/bin/agenthub update` on VM 923 (current prod). Migration log should print `[migrate-access] migrated-self-ca-to-lan` plus the HSTS warning. The operator may need to clear `chrome://net-internals/#hsts` for `agenthub.physhlab.com`.

3. **Update memory**: write a new session handoff covering the PR + the migration result.

4. **Follow-up PRs to schedule**:
   - Cloudflare Tunnel mode (`tunnel` access mode).
   - "Bring your own cert" path (paste cert + key).
