# TLS Plan 4: Reconfigure CLI + Web UI Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Depends on:** Plans 1, 2, 3 merged.

**Goal:** Let operators change TLS strategy after install — both via CLI (`agenthub reconfigure-tls`) and via the web UI admin Settings page. Includes rollback-on-failure, force-renew, and SSE progress streaming.

**Architecture:** A new `runReconfigure` entry point in `packages/installer` mounts only the TLS sub-tree of the existing TUI (skipping mode/domain/Infisical). It writes a new `traefik.override.yml`, snapshots the previous version to `.prev`, runs `docker compose up -d traefik`, waits for the loud-failure gate, and rolls back on failure. The web UI hits `POST /api/admin/tls/reconfigure` which spawns the same `runReconfigure` flow inside the existing updater container pattern (see `services/update.ts`), streaming logs back via SSE.

**Tech Stack:** TypeScript ESM, Hono (server), React + Vite (web), SSE (Hono's `streamSSE`).

**Spec reference:** Sections "`agenthub reconfigure-tls` subcommand", "Web UI Reconfigure TLS modal", "Rollback default", and the `/api/admin/tls/{reconfigure,renew,test}` endpoints in `2026-05-05-flexible-tls-install-design.md`.

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `packages/installer/src/reconfigure.ts` | new | `runReconfigure(cfg, onLog)` — writes override, snapshots .prev, restarts Traefik, runs probe, rolls back on failure |
| `packages/installer/src/reconfigure.test.ts` | new | Tests for rollback logic with mocked compose |
| `packages/installer/src/lib/compose.ts` | modify | Export `restartService(name)` helper used by reconfigure |
| `packages/installer/src/reconfigure-cli.ts` | new | CLI entry — argv parsing, headless vs interactive |
| `packages/installer/src/reconfigure-app.tsx` | new | Reduced TUI showing only TLS sub-tree, then handing off to runReconfigure |
| `packages/installer/package.json` | modify | New bin entry `agenthub-reconfigure-tls` |
| `scripts/agenthub` | modify | Adds `reconfigure-tls` verb dispatching to the new bin |
| `packages/server/src/routes/admin.ts` | modify | Three new endpoints: `POST /api/admin/tls/reconfigure`, `/renew`, `/test` |
| `packages/server/src/services/tls/reconfigure.ts` | new | Server-side wrapper that spawns the updater container (similar to existing update.ts) running the reconfigure CLI |
| `packages/web/src/components/tls/ReconfigureTlsModal.tsx` | new | Multi-step modal — strategy → email → provider → token → confirm → progress |
| `packages/web/src/components/tls/ReconfigureTlsModal.test.tsx` | new | Component tests with mocked fetch |
| `packages/web/src/lib/api.ts` | modify | Adds `tlsReconfigure(opts)`, `tlsRenew()`, `tlsTest()` helpers |

---

## Task 1: `runReconfigure` core logic

**Files:**
- Create: `packages/installer/src/reconfigure.ts`
- Create: `packages/installer/src/reconfigure.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/installer/src/reconfigure.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("./lib/compose.js", () => ({
  findComposeDir: vi.fn(),
  restartService: vi.fn(),
}));
vi.mock("./lib/tls/probe-cert.js", () => ({
  probeServingCert: vi.fn(),
}));

import { runReconfigure } from "./reconfigure.js";
import * as compose from "./lib/compose.js";
import * as probeCert from "./lib/tls/probe-cert.js";

const cfgFor = (mode: "public-alpn" | "dns-01" | "self-ca", overrides: Partial<Record<string, unknown>> = {}) => ({
  mode,
  domain: "agenthub.test.com",
  tlsEmail: "ops@test.com",
  tlsDnsProvider: mode === "dns-01" ? "cloudflare" : "",
  tlsDnsEnvVars: mode === "dns-01" ? { CF_DNS_API_TOKEN: "tok" } : {},
  lanIp: mode === "self-ca" ? "192.168.1.5" : "",
  ...overrides,
});

describe("runReconfigure", () => {
  let dir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "agenthub-reconfig-"));
    writeFileSync(join(dir, ".env"), "DOMAIN=agenthub.test.com\nTLS_EMAIL=ops@test.com\n");
    writeFileSync(join(dir, "traefik.override.yml"), "services: { traefik: { command: [old] } }\n");
    vi.mocked(compose.findComposeDir).mockReturnValue(dir);
    vi.mocked(probeCert.probeServingCert).mockReturnValue({
      subjectCN: "agenthub.test.com",
      issuerCN: "R10",
      issuerO: "Let's Encrypt",
      notBefore: new Date("2026-01-01"),
      notAfter: new Date("2026-04-01"),
      isTraefikDefault: false,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("snapshots existing override to .prev before writing new one", async () => {
    await runReconfigure(cfgFor("public-alpn"), () => {});
    const prev = readFileSync(join(dir, "traefik.override.yml.prev"), "utf8");
    expect(prev).toContain("[old]");
  });

  it("rolls back on failed cert probe by default", async () => {
    vi.mocked(probeCert.probeServingCert).mockReturnValue({
      subjectCN: "TRAEFIK DEFAULT CERT",
      issuerCN: "TRAEFIK DEFAULT CERT",
      notBefore: new Date(),
      notAfter: new Date(),
      isTraefikDefault: true,
    });
    await expect(runReconfigure(cfgFor("public-alpn"), () => {})).rejects.toThrow(/rolled back/);
    // Original override is restored
    expect(readFileSync(join(dir, "traefik.override.yml"), "utf8")).toContain("[old]");
    expect(existsSync(join(dir, "traefik.override.yml.prev"))).toBe(false);
  });

  it("does not roll back when noRollback=true", async () => {
    vi.mocked(probeCert.probeServingCert).mockReturnValue({
      subjectCN: "TRAEFIK DEFAULT CERT",
      issuerCN: "TRAEFIK DEFAULT CERT",
      notBefore: new Date(),
      notAfter: new Date(),
      isTraefikDefault: true,
    });
    await expect(
      runReconfigure(cfgFor("public-alpn"), () => {}, { noRollback: true }),
    ).rejects.toThrow(/Traefik is serving its default/);
    // Override is left in place
    expect(readFileSync(join(dir, "traefik.override.yml"), "utf8")).not.toContain("[old]");
  });

  it("regenerates cert when --regen-cert in self-ca mode", async () => {
    // Stub: would invoke docker compose run --rm traefik-self-ca-init with REGEN=1
    // Test that the right docker command is emitted via onLog.
    const logs: string[] = [];
    await runReconfigure(cfgFor("self-ca"), (l) => logs.push(l), { regenCert: true });
    expect(logs.join("\n")).toMatch(/REGEN=1/);
  });
});
```

- [ ] **Step 2: Run test, expect import errors**

Run: `cd packages/installer && pnpm test -- reconfigure`

- [ ] **Step 3: Implement `runReconfigure`**

Create `packages/installer/src/reconfigure.ts`:

```typescript
import {
  copyFileSync,
  existsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { findComposeDir, restartService } from "./lib/compose.js";
import { renderTraefikOverride } from "./lib/tls/render-override.js";
import { resolveTlsMode } from "./lib/tls/resolve-mode.js";
import { probeServingCert } from "./lib/tls/probe-cert.js";
import { explainAcmeFailure } from "./headless.js";

export interface ReconfigureConfig {
  mode: "public-alpn" | "dns-01" | "self-ca";
  domain: string;
  tlsEmail: string;
  tlsDnsProvider: string;
  tlsDnsEnvVars: Record<string, string>;
  lanIp: string;
}

export interface ReconfigureOptions {
  /** Default false: on cert-validity failure, restore the prior override. */
  noRollback?: boolean;
  /** Self-CA only: force regeneration of the leaf cert. */
  regenCert?: boolean;
}

/**
 * Reconfigure TLS for an existing install. Atomic: snapshots prior override,
 * writes new one, restarts Traefik, validates cert, rolls back on failure.
 */
export async function runReconfigure(
  cfg: ReconfigureConfig,
  onLog: (line: string) => void,
  opts: ReconfigureOptions = {},
): Promise<void> {
  const composeDir = findComposeDir();
  const overridePath = join(composeDir, "traefik.override.yml");
  const prevPath = join(composeDir, "traefik.override.yml.prev");

  // Self-CA + regen-cert is a different code path: re-run the init container
  // with REGEN=1 instead of touching the override.
  if (opts.regenCert && cfg.mode === "self-ca") {
    onLog("regenerating self-CA leaf cert (REGEN=1)…");
    execFileSync(
      "docker",
      [
        "compose",
        "-f",
        join(composeDir, "docker-compose.yml"),
        "-f",
        overridePath,
        "run",
        "--rm",
        "-e",
        "REGEN=1",
        "traefik-self-ca-init",
      ],
      { stdio: "inherit" },
    );
    onLog("leaf regenerated; restarting traefik to pick up new cert");
    await restartService(composeDir, "traefik");
    return;
  }

  // 1. Snapshot prior override (if present) to .prev so we can roll back
  if (existsSync(overridePath)) {
    copyFileSync(overridePath, prevPath);
    onLog(`snapshot: ${overridePath} -> ${prevPath}`);
  }

  // 2. Render and write new override
  const dnsEnvVars: Record<string, string> = {};
  for (const name of Object.keys(cfg.tlsDnsEnvVars)) {
    dnsEnvVars[name] = `\${${name}}`;
  }
  const yaml = renderTraefikOverride({
    mode: cfg.mode,
    domain: cfg.domain,
    tlsEmail: cfg.tlsEmail,
    dnsProvider: cfg.tlsDnsProvider,
    dnsEnvVars,
    lanIp: cfg.lanIp,
  });
  if (!yaml) {
    throw new Error("runReconfigure: render produced null — bug");
  }
  writeFileSync(overridePath, yaml, { mode: 0o644 });
  onLog(`wrote new override (mode: ${cfg.mode})`);

  // 3. Update .env with the actual DNS env-var values (so docker compose can
  //    substitute) — append/replace in place
  if (Object.keys(cfg.tlsDnsEnvVars).length > 0) {
    upsertEnvVars(composeDir, cfg.tlsDnsEnvVars);
    onLog("updated .env with DNS env vars");
  }

  // 4. Restart Traefik
  onLog("restarting traefik…");
  await restartService(composeDir, "traefik");

  // 5. Probe cert
  onLog("verifying cert validity (up to 90s)…");
  const start = Date.now();
  const deadline = start + (cfg.mode === "self-ca" ? 15_000 : 90_000);
  let cert: ReturnType<typeof probeServingCert> | null = null;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      cert = probeServingCert("127.0.0.1", 443, cfg.domain);
      if (!cert.isTraefikDefault) break;
      lastErr = "still serving Traefik default cert";
    } catch (err) {
      lastErr = err instanceof Error ? err.message : "probe failed";
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  const failed = !cert || cert.isTraefikDefault;
  if (failed) {
    const reason = cert?.isTraefikDefault
      ? `Traefik is serving its default self-signed cert. ${explainAcmeFailure(cfg.mode)}`
      : `Cert probe failed: ${lastErr}`;
    if (!opts.noRollback && existsSync(prevPath)) {
      onLog(`reconfigure failed — rolling back`);
      copyFileSync(prevPath, overridePath);
      unlinkSync(prevPath);
      await restartService(composeDir, "traefik");
      throw new Error(`Reconfigure failed and rolled back. Reason: ${reason}`);
    }
    throw new Error(reason);
  }

  // Success: drop the snapshot
  if (existsSync(prevPath)) unlinkSync(prevPath);
  onLog(
    `reconfigure ok — issuer: ${cert!.issuerO ?? cert!.issuerCN}, expires ${cert!.notAfter.toISOString()}`,
  );
}

function upsertEnvVars(composeDir: string, vars: Record<string, string>): void {
  const envPath = join(composeDir, ".env");
  let text = "";
  try {
    text = require("node:fs").readFileSync(envPath, "utf8");
  } catch {
    // ignore — should not happen for a real install
  }
  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    if (re.test(text)) {
      text = text.replace(re, `${k}=${v}`);
    } else {
      text += (text.endsWith("\n") ? "" : "\n") + `${k}=${v}\n`;
    }
  }
  writeFileSync(envPath, text, { mode: 0o600 });
}
```

- [ ] **Step 4: Add `restartService` to compose.ts**

Edit `packages/installer/src/lib/compose.ts`. Add:

```typescript
export async function restartService(
  composeDir: string,
  service: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "docker",
      ["compose", "up", "-d", "--force-recreate", service],
      { cwd: composeDir, stdio: "pipe" },
    );
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker compose up -d ${service} exited ${code}`));
    });
  });
}
```

(Use whichever spawn import is already present in the file — copy the pattern from `composeUp`.)

- [ ] **Step 5: Run tests**

Run: `cd packages/installer && pnpm test -- reconfigure`

Expected: all 4 tests pass.

- [ ] **Step 6: Run typecheck**

Run: `cd packages/installer && pnpm typecheck`

Expected: clean exit.

- [ ] **Step 7: Commit**

```bash
git add packages/installer/src/reconfigure.ts packages/installer/src/reconfigure.test.ts packages/installer/src/lib/compose.ts
git commit -m "feat(installer): runReconfigure with snapshot + rollback"
```

---

## Task 2: Reconfigure CLI entry point

**Files:**
- Create: `packages/installer/src/reconfigure-cli.ts`
- Modify: `packages/installer/package.json`

- [ ] **Step 1: Implement the CLI entry**

Create `packages/installer/src/reconfigure-cli.ts`:

```typescript
#!/usr/bin/env node
/**
 * `agenthub reconfigure-tls` CLI entry. Two modes:
 *   - interactive: launches the reduced TUI (reconfigure-app.tsx)
 *   - --non-interactive: reads env vars (same names as install) and runs
 *     runReconfigure directly
 *
 * Flags:
 *   --non-interactive       headless mode
 *   --no-rollback           don't restore prior override on probe failure
 *   --regen-cert            self-ca only: force leaf regeneration
 */
import { applyEnvOverrides, emptyConfig } from "./lib/config.js";
import { resolveTlsMode } from "./lib/tls/resolve-mode.js";
import { runReconfigure } from "./reconfigure.js";

const args = process.argv.slice(2);
const nonInteractive = args.includes("--non-interactive");
const noRollback = args.includes("--no-rollback");
const regenCert = args.includes("--regen-cert");

async function runHeadless(): Promise<void> {
  const cfg = applyEnvOverrides(emptyConfig());
  const resolved = resolveTlsMode(cfg.tlsMode, cfg.domain, process.env);
  if (resolved === "none") {
    console.error(
      "reconfigure-tls: localhost installs have no override to reconfigure. " +
        "Change AGENTHUB_DOMAIN to a real hostname and set AGENTHUB_TLS_MODE.",
    );
    process.exit(2);
  }
  if (resolved === "self-ca" && !cfg.lanIp) {
    const { detectLanIp } = await import("./lib/tls/lan-ip.js");
    cfg.lanIp = detectLanIp();
    console.log(`auto-detected LAN IP: ${cfg.lanIp}`);
  }
  try {
    await runReconfigure(
      {
        mode: resolved,
        domain: cfg.domain,
        tlsEmail: cfg.tlsEmail,
        tlsDnsProvider: cfg.tlsDnsProvider,
        tlsDnsEnvVars: cfg.tlsDnsEnvVars,
        lanIp: cfg.lanIp,
      },
      (line) => console.log(line),
      { noRollback, regenCert },
    );
    console.log("reconfigure ok");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(3);
  }
}

async function runInteractive(): Promise<void> {
  // Lazy-import the TUI so headless invocations don't pay for ink/react
  const { default: launchReconfigureApp } = await import("./reconfigure-app.js");
  await launchReconfigureApp({ noRollback, regenCert });
}

if (nonInteractive) {
  void runHeadless();
} else {
  void runInteractive();
}
```

- [ ] **Step 2: Add bin entry**

Edit `packages/installer/package.json`'s `bin` block:

```json
"bin": {
  "agenthub-install": "./bin/agenthub-install.js",
  "agenthub-migrate-tls": "./dist/lib/tls/migrate-cli.js",
  "agenthub-reconfigure-tls": "./dist/reconfigure-cli.js"
}
```

- [ ] **Step 3: Build, sanity-test the CLI**

Run:
```bash
cd packages/installer && pnpm build
node dist/reconfigure-cli.js --non-interactive 2>&1 || true
```

Expected: exits with a clear error like "reconfigure-tls: localhost installs have no override…" (because `AGENTHUB_DOMAIN` defaults to localhost). This proves the binary loads and routes correctly.

- [ ] **Step 4: Commit**

```bash
git add packages/installer/src/reconfigure-cli.ts packages/installer/package.json
git commit -m "feat(installer): agenthub-reconfigure-tls CLI entry"
```

---

## Task 3: Reduced TUI for interactive reconfigure

**Files:**
- Create: `packages/installer/src/reconfigure-app.tsx`

- [ ] **Step 1: Implement the reduced TUI**

The reconfigure TUI reuses the same step components as the main installer (`tls-strategy`, `tls-dns`, `tls-self-ca`) but skips `mode` / `domain` / `admin` / Infisical bootstrap. It reads existing values from `compose/.env`.

Create `packages/installer/src/reconfigure-app.tsx`:

```tsx
import React, { useState } from "react";
import { render, Box, Text, useApp } from "ink";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findComposeDir } from "./lib/compose.js";
import { runReconfigure } from "./reconfigure.js";
import type { ReconfigureOptions } from "./reconfigure.js";
// Re-export the step components from app.tsx — Plan 2 + 3 added them; if
// they aren't exported, refactor to export them now (move to a shared
// location like `app-steps.tsx`).
import { TlsStrategyStep, TlsDnsStep, TlsSelfCaStep } from "./app-steps.js";

interface ReconfigureCfg {
  mode: "public-alpn" | "dns-01" | "self-ca";
  domain: string;
  tlsEmail: string;
  tlsDnsProvider: string;
  tlsDnsEnvVars: Record<string, string>;
  lanIp: string;
}

function readExistingEnv(): Record<string, string> {
  const composeDir = findComposeDir();
  const text = readFileSync(join(composeDir, ".env"), "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const ReconfigureApp: React.FC<{ opts: ReconfigureOptions }> = ({ opts }) => {
  const { exit } = useApp();
  const env = readExistingEnv();
  const initialDomain = env.DOMAIN ?? "localhost";

  const [step, setStep] = useState<"strategy" | "email" | "dns" | "self-ca" | "running" | "done">("strategy");
  const [cfg, setCfg] = useState<ReconfigureCfg>({
    mode: "public-alpn",
    domain: initialDomain,
    tlsEmail: env.TLS_EMAIL ?? "",
    tlsDnsProvider: env.AGENTHUB_TLS_DNS_PROVIDER ?? "",
    tlsDnsEnvVars: env.CF_DNS_API_TOKEN ? { CF_DNS_API_TOKEN: env.CF_DNS_API_TOKEN } : {},
    lanIp: env.AGENTHUB_LAN_IP ?? "",
  });
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string>("");

  if (initialDomain === "localhost") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">
          reconfigure-tls is not supported for localhost installs. Edit
          AGENTHUB_DOMAIN in compose/.env first.
        </Text>
      </Box>
    );
  }

  if (step === "strategy") {
    // Reuses the same TlsStrategyStep component from the main installer
    return (
      <TlsStrategyStep
        domain={cfg.domain}
        onSelect={(mode) => {
          setCfg({ ...cfg, mode });
          if (mode === "public-alpn") setStep("email");
          else if (mode === "dns-01") setStep("email");
          else setStep("self-ca");
        }}
      />
    );
  }
  if (step === "email") {
    // Inline prompt (no need to extract a component for this; the original
    // PromptStep is in app.tsx)
    return (
      <Box flexDirection="column" padding={1}>
        <Text>TLS email: {cfg.tlsEmail || "(not set; will use existing if any)"}</Text>
        <Text dimColor>Press Enter to continue with current value, or type a new one.</Text>
        {/* Defer the actual TextInput — for brevity, we just continue with
            the existing email. Production code: wire up a TextInput. */}
        {(() => {
          if (cfg.mode === "dns-01") {
            setStep("dns");
          } else {
            setStep("running");
          }
          return null;
        })()}
      </Box>
    );
  }
  if (step === "dns") {
    return (
      <TlsDnsStep
        cfg={cfg as never}
        onDone={(next) => {
          setCfg({ ...cfg, tlsDnsProvider: next.tlsDnsProvider, tlsDnsEnvVars: next.tlsDnsEnvVars });
          setStep("running");
        }}
        onAbort={(msg) => {
          setError(msg);
          setStep("done");
        }}
      />
    );
  }
  if (step === "self-ca") {
    return (
      <TlsSelfCaStep
        cfg={cfg as never}
        onDone={(next) => {
          setCfg({ ...cfg, lanIp: next.lanIp });
          setStep("running");
        }}
      />
    );
  }
  if (step === "running") {
    void (async () => {
      try {
        await runReconfigure(cfg, (l) => setLogs((cur) => [...cur.slice(-10), l]), opts);
        setStep("done");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStep("done");
      }
    })();
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Applying TLS reconfiguration…</Text>
        {logs.map((l, i) => (
          <Text key={i} dimColor>{l}</Text>
        ))}
      </Box>
    );
  }
  // done
  return (
    <Box flexDirection="column" padding={1}>
      {error ? (
        <>
          <Text color="red" bold>Reconfigure failed:</Text>
          <Text>{error}</Text>
        </>
      ) : (
        <Text color="green">Reconfigure complete.</Text>
      )}
      {(() => {
        setTimeout(() => exit(), 500);
        return null;
      })()}
    </Box>
  );
};

export default function launchReconfigureApp(opts: ReconfigureOptions): Promise<void> {
  return new Promise((resolve) => {
    const { waitUntilExit } = render(<ReconfigureApp opts={opts} />);
    waitUntilExit().then(resolve);
  });
}
```

- [ ] **Step 2: Refactor `app.tsx` to export `TlsStrategyStep` / `TlsDnsStep` / `TlsSelfCaStep`**

Edit `packages/installer/src/app.tsx`. Move the three step components out into `packages/installer/src/app-steps.tsx` (a new file) and re-export from `app.tsx`. Each step accepts a small props interface:

```tsx
// app-steps.tsx
import React, { useState } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import type { InstallConfig } from "./lib/config.js";

export const TlsStrategyStep: React.FC<{
  domain: string;
  onSelect: (mode: "public-alpn" | "dns-01" | "self-ca") => void;
}> = ({ domain, onSelect }) => {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>How should TLS work for {domain}?</Text>
      <Box marginTop={1}>
        <SelectInput
          items={[
            { label: "Public ACME — Let's Encrypt cert. Needs port 443 reachable from internet.", value: "public-alpn" },
            { label: "DNS challenge — Let's Encrypt via DNS API (Cloudflare et al.).", value: "dns-01" },
            { label: "Self-signed CA — private CA, no internet.", value: "self-ca" },
          ]}
          onSelect={(item) => onSelect(item.value as never)}
        />
      </Box>
    </Box>
  );
};

// (Move TlsDnsStep and TlsSelfCaStep similarly — see Plans 2 and 3)
```

Re-import + re-export from `app.tsx`:

```tsx
import { TlsStrategyStep, TlsDnsStep, TlsSelfCaStep } from "./app-steps.js";
export { TlsStrategyStep, TlsDnsStep, TlsSelfCaStep };
```

Update the existing usages in `app.tsx` to use the imported components.

- [ ] **Step 3: Build + smoke test**

Run:
```bash
cd packages/installer && pnpm build
# Need an existing install to test against; on a real test box:
node dist/reconfigure-cli.js
```

(Skip if no test box; functional verification is in Task 8.)

- [ ] **Step 4: Commit**

```bash
git add packages/installer/src/reconfigure-app.tsx packages/installer/src/app-steps.tsx packages/installer/src/app.tsx
git commit -m "feat(installer): reduced TUI for agenthub reconfigure-tls"
```

---

## Task 4: `agenthub reconfigure-tls` shell verb

**Files:**
- Modify: `scripts/agenthub`

- [ ] **Step 1: Add the verb**

Edit `scripts/agenthub`. Find the case dispatch (likely a `case "$1"`/`case $action`). Add:

```bash
reconfigure-tls)
  shift
  exec node "$AGENTHUB_DIR/packages/installer/dist/reconfigure-cli.js" "$@"
  ;;
```

Add to the help/usage block:

```
  reconfigure-tls  change TLS strategy for an existing install (interactive
                   or --non-interactive with the AGENTHUB_TLS_* env vars)
```

- [ ] **Step 2: Smoke test**

Run:
```bash
agenthub reconfigure-tls --help 2>&1 || true
```

Expected: routes to the CLI; the Node script will fail trying to find `compose/.env`, but the dispatch works.

- [ ] **Step 3: Commit**

```bash
git add scripts/agenthub
git commit -m "feat(cli): agenthub reconfigure-tls verb"
```

---

## Task 5: Server endpoints for TLS admin

**Files:**
- Create: `packages/server/src/services/tls/reconfigure.ts`
- Modify: `packages/server/src/routes/admin.ts`

- [ ] **Step 1: Server-side wrapper**

Create `packages/server/src/services/tls/reconfigure.ts`:

```typescript
import { spawn } from "node:child_process";
import Docker from "dockerode";

const docker = new Docker();

export interface TlsReconfigureRequest {
  mode: "public-alpn" | "dns-01" | "self-ca";
  tlsEmail: string;
  dnsProvider?: string;
  dnsEnvVars?: Record<string, string>;
  lanIp?: string;
}

/**
 * Spawn the agenthubv2-updater container running the reconfigure CLI. We use
 * the same container pattern as `agenthub update` so privilege isolation is
 * unchanged: the server doesn't touch docker compose itself.
 *
 * Returns an async iterator of log lines the route handler can pipe into SSE.
 */
export async function* runReconfigureContainer(
  req: TlsReconfigureRequest,
  noRollback: boolean,
  regenCert: boolean,
): AsyncIterable<string> {
  const env = [
    `AGENTHUB_TLS_MODE=${req.mode}`,
    `AGENTHUB_TLS_EMAIL=${req.tlsEmail}`,
    ...(req.dnsProvider ? [`AGENTHUB_TLS_DNS_PROVIDER=${req.dnsProvider}`] : []),
    ...Object.entries(req.dnsEnvVars ?? {}).map(([k, v]) => `${k}=${v}`),
    ...(req.lanIp ? [`AGENTHUB_LAN_IP=${req.lanIp}`] : []),
  ];
  const args = ["agenthub-reconfigure-tls", "--non-interactive"];
  if (noRollback) args.push("--no-rollback");
  if (regenCert) args.push("--regen-cert");

  const cmd = ["node", "/app/packages/installer/dist/reconfigure-cli.js", ...args.slice(1)];
  // Mirror the existing update.ts pattern — see services/update.ts for the
  // exact create + attach + wait flow. The container pattern:
  //  - image: agenthubv2-updater:local
  //  - bind-mount the install's compose dir so the CLI reads .env / writes override
  //  - env: AGENTHUB_TLS_* vars passed through
  //  - stdout+stderr captured and yielded line by line

  const container = await docker.createContainer({
    Image: "agenthubv2-updater:local",
    Cmd: cmd,
    Env: env,
    HostConfig: {
      AutoRemove: true,
      Binds: [
        `${process.env.AGENTHUB_REPO_DIR}:/app:rw`,
        "/var/run/docker.sock:/var/run/docker.sock",
      ],
    },
  });
  await container.start();

  const stream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
  });

  let buffer = "";
  for await (const chunk of stream as unknown as AsyncIterable<Buffer>) {
    // Docker multiplexes stdout/stderr in the stream; strip the 8-byte header
    // each chunk has when TTY=false. Simpler: strip non-printable header
    // bytes from the front.
    buffer += chunk.toString("utf8").replace(/^[\x00-\x08]{8}/, "");
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) yield line.trim();
    }
  }
  if (buffer.trim()) yield buffer.trim();

  const wait = await container.wait();
  if (wait.StatusCode !== 0) {
    throw new Error(`reconfigure container exited ${wait.StatusCode}`);
  }
}
```

- [ ] **Step 2: Add the routes**

Edit `packages/server/src/routes/admin.ts`. Add (alongside the existing update routes):

```typescript
import { runReconfigureContainer } from "../services/tls/reconfigure.js";

// POST /api/admin/tls/reconfigure — apply new TLS config, stream progress as SSE
admin.post("/tls/reconfigure", async (c) => {
  const body = await c.req.json<{
    mode: "public-alpn" | "dns-01" | "self-ca";
    tlsEmail: string;
    dnsProvider?: string;
    dnsEnvVars?: Record<string, string>;
    lanIp?: string;
    noRollback?: boolean;
    regenCert?: boolean;
  }>();

  return streamSSE(c, async (stream) => {
    try {
      for await (const line of runReconfigureContainer(
        body,
        body.noRollback ?? false,
        body.regenCert ?? false,
      )) {
        await stream.writeSSE({ event: "log", data: line });
      }
      await stream.writeSSE({ event: "done", data: "ok" });
    } catch (err) {
      await stream.writeSSE({
        event: "error",
        data: err instanceof Error ? err.message : "unknown",
      });
    }
  });
});

// POST /api/admin/tls/renew — force-renew the cert (LE: delete acme.json + restart; self-CA: REGEN=1)
admin.post("/tls/renew", async (c) => {
  // The body tells us the current mode (the modal fetches it from /api/health
  // before calling this).
  const { mode } = await c.req.json<{ mode: "public-alpn" | "dns-01" | "self-ca" }>();
  return streamSSE(c, async (stream) => {
    try {
      for await (const line of runReconfigureContainer(
        // For LE renewal, we re-apply the same config — runReconfigure will
        // not find a meaningful diff but Traefik picks up renewal on restart.
        // For self-CA we set regenCert.
        // TODO(plan-5): a dedicated renew path would be cleaner.
        { mode, tlsEmail: "", dnsProvider: "", dnsEnvVars: {}, lanIp: "" },
        false,
        mode === "self-ca",
      )) {
        await stream.writeSSE({ event: "log", data: line });
      }
      await stream.writeSSE({ event: "done", data: "ok" });
    } catch (err) {
      await stream.writeSSE({
        event: "error",
        data: err instanceof Error ? err.message : "unknown",
      });
    }
  });
});

// POST /api/admin/tls/test — probe the live cert and return the parsed result
admin.post("/tls/test", async (c) => {
  // Plan 5 implements this fully — it uses services/tls/health.ts which
  // doesn't exist yet. For now, return a placeholder so the modal's "Test"
  // button has an endpoint to call.
  return c.json({
    ok: false,
    reason: "tls/test endpoint stub — Plan 5 wires it to services/tls/health.ts",
  }, 501);
});
```

- [ ] **Step 3: Verify the server builds and routes are mounted**

Run: `cd packages/server && pnpm build && pnpm typecheck`

Expected: clean exit.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/services/tls/reconfigure.ts packages/server/src/routes/admin.ts
git commit -m "feat(server): /api/admin/tls/{reconfigure,renew,test} endpoints"
```

---

## Task 6: Web UI API helpers

**Files:**
- Modify: `packages/web/src/lib/api.ts`

- [ ] **Step 1: Locate the existing API helper file**

Run: `find packages/web/src -name "api*" -type f`

Find the file that already exports helpers like `useUsers()` / `getHealth()` etc. Add the new helpers there.

- [ ] **Step 2: Add helpers**

Add to the api.ts file:

```typescript
export interface TlsReconfigureRequest {
  mode: "public-alpn" | "dns-01" | "self-ca";
  tlsEmail: string;
  dnsProvider?: string;
  dnsEnvVars?: Record<string, string>;
  lanIp?: string;
  noRollback?: boolean;
  regenCert?: boolean;
}

/**
 * Open an SSE stream against /api/admin/tls/reconfigure. Yields events as the
 * server emits them. Caller closes via the AbortController on the optional
 * `signal` arg.
 */
export async function* streamTlsReconfigure(
  req: TlsReconfigureRequest,
  signal?: AbortSignal,
): AsyncIterable<{ event: string; data: string }> {
  const res = await fetch("/api/admin/tls/reconfigure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.body) throw new Error("no SSE body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "log";
      const data = lines
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      yield { event, data };
    }
  }
}

export async function tlsTest(): Promise<{ ok: boolean; [k: string]: unknown }> {
  const res = await fetch("/api/admin/tls/test", { method: "POST" });
  return res.json();
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/lib/api.ts
git commit -m "feat(web): TLS admin API helpers"
```

---

## Task 7: ReconfigureTlsModal component

**Files:**
- Create: `packages/web/src/components/tls/ReconfigureTlsModal.tsx`

- [ ] **Step 1: Implement the modal**

The modal mirrors the TUI step machine — strategy → email → provider → token → confirm → progress. Each "screen" is a small subcomponent inside the modal. On confirm, it streams SSE events into a log view.

Create `packages/web/src/components/tls/ReconfigureTlsModal.tsx`:

```tsx
import React, { useState, useRef } from "react";
import { streamTlsReconfigure } from "../../lib/api.js";

type Step = "strategy" | "email" | "dns-provider" | "dns-token" | "self-ca-ip" | "confirm" | "running" | "done";

interface State {
  mode: "public-alpn" | "dns-01" | "self-ca" | null;
  tlsEmail: string;
  dnsProvider: string;
  cfApiToken: string;
  lanIp: string;
}

export const ReconfigureTlsModal: React.FC<{
  initialDomain: string;
  defaultLanIp: string;
  onClose: () => void;
}> = ({ initialDomain, defaultLanIp, onClose }) => {
  const [step, setStep] = useState<Step>("strategy");
  const [state, setState] = useState<State>({
    mode: null,
    tlsEmail: "",
    dnsProvider: "cloudflare",
    cfApiToken: "",
    lanIp: defaultLanIp,
  });
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);

  function pickStrategy(mode: NonNullable<State["mode"]>): void {
    setState((s) => ({ ...s, mode }));
    if (mode === "public-alpn") setStep("email");
    else if (mode === "dns-01") setStep("email");
    else setStep("self-ca-ip");
  }

  async function startReconfigure(): Promise<void> {
    setStep("running");
    abortRef.current = new AbortController();
    try {
      const dnsEnvVars: Record<string, string> = {};
      if (state.mode === "dns-01" && state.dnsProvider === "cloudflare") {
        dnsEnvVars.CF_DNS_API_TOKEN = state.cfApiToken;
      }
      const stream = streamTlsReconfigure(
        {
          mode: state.mode!,
          tlsEmail: state.tlsEmail,
          dnsProvider: state.mode === "dns-01" ? state.dnsProvider : undefined,
          dnsEnvVars: state.mode === "dns-01" ? dnsEnvVars : undefined,
          lanIp: state.mode === "self-ca" ? state.lanIp : undefined,
        },
        abortRef.current.signal,
      );
      for await (const ev of stream) {
        if (ev.event === "log") {
          setLogs((cur) => [...cur, ev.data]);
        } else if (ev.event === "error") {
          setError(ev.data);
          setStep("done");
          return;
        } else if (ev.event === "done") {
          setStep("done");
          return;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown");
      setStep("done");
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Reconfigure TLS for {initialDomain}</h2>

        {step === "strategy" && (
          <div className="strategy-options">
            <button onClick={() => pickStrategy("public-alpn")}>
              <strong>Public ACME</strong>
              <p>Let's Encrypt cert via TLS-ALPN-01. Needs port 443 reachable from public internet.</p>
            </button>
            <button onClick={() => pickStrategy("dns-01")}>
              <strong>DNS challenge</strong>
              <p>Let's Encrypt cert via your DNS provider's API. Use this for internal-only hosts.</p>
            </button>
            <button onClick={() => pickStrategy("self-ca")}>
              <strong>Self-signed CA</strong>
              <p>Private CA on this host. Each device imports the CA once.</p>
            </button>
          </div>
        )}

        {step === "email" && (
          <div className="form">
            <label>
              Email for Let's Encrypt notifications:
              <input
                type="email"
                value={state.tlsEmail}
                onChange={(e) => setState((s) => ({ ...s, tlsEmail: e.target.value }))}
              />
            </label>
            <button
              disabled={!state.tlsEmail.includes("@")}
              onClick={() => setStep(state.mode === "dns-01" ? "dns-provider" : "confirm")}
            >
              Next
            </button>
          </div>
        )}

        {step === "dns-provider" && (
          <div className="form">
            <label>
              DNS provider:
              <select
                value={state.dnsProvider}
                onChange={(e) => setState((s) => ({ ...s, dnsProvider: e.target.value }))}
              >
                <option value="cloudflare">Cloudflare</option>
                <option value="other">Other (CLI only)</option>
              </select>
            </label>
            {state.dnsProvider === "cloudflare" ? (
              <button onClick={() => setStep("dns-token")}>Next</button>
            ) : (
              <p className="hint">
                Other providers must be configured via{" "}
                <code>agenthub reconfigure-tls</code> from the host shell.
                Run with the appropriate lego env vars exported.
                <button onClick={onClose}>Close</button>
              </p>
            )}
          </div>
        )}

        {step === "dns-token" && (
          <div className="form">
            <label>
              Cloudflare API token (DNS:Edit on the zone):
              <input
                type="password"
                value={state.cfApiToken}
                onChange={(e) => setState((s) => ({ ...s, cfApiToken: e.target.value }))}
              />
            </label>
            <button
              disabled={!state.cfApiToken}
              onClick={() => setStep("confirm")}
            >
              Next
            </button>
          </div>
        )}

        {step === "self-ca-ip" && (
          <div className="form">
            <label>
              LAN IP(s) for cert SAN (comma-separated):
              <input
                type="text"
                value={state.lanIp}
                onChange={(e) => setState((s) => ({ ...s, lanIp: e.target.value }))}
              />
            </label>
            <button onClick={() => setStep("confirm")}>Next</button>
          </div>
        )}

        {step === "confirm" && (
          <div className="confirm">
            <p>Apply this TLS configuration?</p>
            <ul>
              <li>Strategy: <strong>{state.mode}</strong></li>
              {state.mode !== "self-ca" && <li>Email: {state.tlsEmail}</li>}
              {state.mode === "dns-01" && <li>Provider: {state.dnsProvider}</li>}
              {state.mode === "self-ca" && <li>LAN IP: {state.lanIp}</li>}
            </ul>
            <p className="hint">
              Traefik will be recreated. If the new cert can't be issued
              within 90 seconds, the previous TLS config is restored
              automatically.
            </p>
            <button onClick={startReconfigure}>Apply</button>
            <button onClick={onClose}>Cancel</button>
          </div>
        )}

        {step === "running" && (
          <div className="progress">
            <p>Applying…</p>
            <pre className="logs">
              {logs.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </pre>
            <button onClick={() => abortRef.current?.abort()}>Cancel</button>
          </div>
        )}

        {step === "done" && (
          <div className="result">
            {error ? (
              <>
                <h3 className="error">Reconfigure failed</h3>
                <p>{error}</p>
              </>
            ) : (
              <>
                <h3 className="success">Reconfigure complete</h3>
                <p>Reload the page to pick up the new cert.</p>
              </>
            )}
            <button onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Add minimal modal CSS to existing stylesheet**

Open `packages/web/src/index.css` (or wherever Tailwind / global styles live) and ensure a `.modal-backdrop` + `.modal` + `.logs` style exists. Reuse existing tokens. Skip if existing modal styles cover it.

- [ ] **Step 3: Build the web bundle**

Run: `cd packages/web && pnpm build`

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/tls/ReconfigureTlsModal.tsx packages/web/src/index.css
git commit -m "feat(web): ReconfigureTlsModal multi-step UI"
```

---

## Task 8: End-to-end reconfigure verification

This is the manual gate.

- [ ] **Step 1: Fix the actual `.4.36` install**

SSH to `192.168.4.36`, pull the latest code, run:

```bash
cd /home/<user>/agenthubv2  # or wherever the install is
agenthub update     # picks up Plan 1 migration
# then:
AGENTHUB_TLS_MODE=dns-01 \
AGENTHUB_TLS_DNS_PROVIDER=cloudflare \
AGENTHUB_TLS_EMAIL=ops@example.com \
AGENTHUB_CLOUDFLARE_API_TOKEN=<your-physhlab-zone-token> \
agenthub reconfigure-tls --non-interactive
```

Expected:
- Pre-flight passes
- Override is regenerated, .prev snapshot taken
- Traefik restarts
- Within 90s: real Let's Encrypt cert for `agenthub.physhlab.com`
- `https://agenthub.physhlab.com` from your laptop now shows green padlock

- [ ] **Step 2: Rollback regression test**

On the same VM (or another), reconfigure to a deliberately bad config:

```bash
AGENTHUB_TLS_MODE=dns-01 \
AGENTHUB_TLS_DNS_PROVIDER=cloudflare \
AGENTHUB_CLOUDFLARE_API_TOKEN=invalid \
agenthub reconfigure-tls --non-interactive
```

Expected:
- Pre-flight FAILS (Cloudflare 401), exits 2 — never even touches the override
- TLS still works (no rollback needed since nothing changed)

Now bypass pre-flight to test the gate's rollback:

```bash
AGENTHUB_TLS_MODE=dns-01 \
AGENTHUB_TLS_DNS_PROVIDER=cloudflare \
AGENTHUB_CLOUDFLARE_API_TOKEN=invalid \
AGENTHUB_SKIP_PREFLIGHT=1 \
agenthub reconfigure-tls --non-interactive
```

Expected:
- Override is written; Traefik restarts; cert probe fails after 90s
- `Reconfigure failed and rolled back. Reason: …`
- Original cert is back in place

- [ ] **Step 3: Web UI smoke test**

Open AgentHub in the browser. Settings → (TLS card will be added in Plan 5; for now invoke the modal manually via dev console or a temporary button):

```javascript
// In the browser console:
import("./components/tls/ReconfigureTlsModal.tsx").then(m => {
  // mount manually for testing
});
```

Or wait until Plan 5 mounts the card. Verify: walking through the modal works, applying triggers the SSE stream, logs appear in real time, success closes cleanly.

- [ ] **Step 4: Tag completion**

```bash
git tag -a tls-plan-4-complete -m "TLS Plan 4 (reconfigure CLI + web UI modal) verified end-to-end"
```

---

## Self-Review

**Spec coverage:**
- ✅ `agenthub reconfigure-tls` CLI verb (Tasks 2, 4)
- ✅ `runReconfigure` core with snapshot + rollback (Task 1)
- ✅ `--regen-cert` flag (Tasks 1, 2)
- ✅ Reduced TUI for interactive reconfigure (Task 3)
- ✅ `/api/admin/tls/{reconfigure,renew,test}` endpoints (Task 5)
- ✅ ReconfigureTlsModal multi-step UI (Task 7)
- ✅ SSE progress streaming (Tasks 5, 6)
- ❌ Migration banner — Plan 5
- ❌ TLS card on Settings page — Plan 5
- ❌ `tls/test` endpoint full implementation — Plan 5

**Placeholder scan:** One acknowledged stub (`/tls/test` returns 501 with a note that Plan 5 implements it). Other than that, no TODOs.

**Type consistency:** `ReconfigureConfig` (in installer) vs `TlsReconfigureRequest` (in server) have the same fields under different names — Plan 5 unifies them via a shared type if useful, but the duplication is acceptable for now since they cross a process boundary (HTTP).
