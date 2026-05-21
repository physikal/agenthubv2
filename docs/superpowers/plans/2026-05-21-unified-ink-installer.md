# Unified Ink Installer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the docker image builds and the install bringup into the Ink TUI as an engine-driven step list with progress bars (builds run in the background while the user configures), keeping a minimal shell bootstrap.

**Architecture:** A headless install engine runs phases as async tasks (`queued|running|done|failed` + optional `{current,total}` progress), streaming all raw output to a timestamped log file and keeping a per-task tail for failures. Ink components subscribe and render a step list + progress bars. `install.sh` shrinks to a quiet bootstrap (pnpm install, build installer, install CLI) and the docker builds move into the engine. The shared headless `runInstall` is left intact to avoid destabilizing the non-interactive path.

**Tech Stack:** TypeScript (Node 22, ESM, strict + `verbatimModuleSyntax`), Ink 5 + React 18, vitest. Custom progress bar (no new dep). Docker BuildKit `--progress=plain`.

**Spec:** `docs/superpowers/specs/2026-05-21-unified-ink-installer-design.md`

---

## File Structure

**Create (engine — pure/Node, vitest-tested):**
- `packages/installer/src/lib/engine/buildkit-parse.ts` (+ `.test.ts`) — parse a `--progress=plain` line → `{ step, total } | null`.
- `packages/installer/src/lib/engine/log-file.ts` (+ `.test.ts`) — timestamped install log + per-task tail ring buffer.
- `packages/installer/src/lib/engine/task-store.ts` (+ `.test.ts`) — task state store with subscribe/snapshot.
- `packages/installer/src/lib/engine/docker-build.ts` (+ `.test.ts` for the pure arg builder) — spawn `docker build`, wire progress.
- `packages/installer/src/lib/engine/install-engine.ts` — image-build task specs, `runBuilds`, `runBringup` (engine version of the bringup, reusing existing `run.ts` helpers).

**Create (UI — Ink, manually verified):**
- `packages/installer/src/components/ProgressBar.tsx`
- `packages/installer/src/components/StepList.tsx`
- `packages/installer/src/components/BuildPanel.tsx`

**Modify:**
- `packages/installer/src/app.tsx` — start background builds on mount; show `BuildPanel` beside config; run-step renders engine-driven `StepList` + a failure view.
- `scripts/install.sh` — remove the 3 `docker build` blocks; collapse `pnpm install`/build output to clean lines (capture verbose to the install log); keep CLI install + `exec`.

**Unchanged (important):** `run.ts`'s `runInstall` (headless path) and `headless.ts`. The engine reuses the same lower-level helpers (`compose.ts`, `infisical-bootstrap.ts`, the traefik writers) so behavior matches; the ~6-step bringup *sequence* is intentionally expressed once more in `install-engine.ts` rather than refactoring the shared `runInstall` (lower risk to the working headless path).

---

## Phase A — Engine primitives (TDD)

### Task 1: BuildKit progress parser

**Files:** Create `packages/installer/src/lib/engine/buildkit-parse.ts` + `.test.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// buildkit-parse.test.ts
import { describe, it, expect } from "vitest";
import { parseBuildkitProgress } from "./buildkit-parse.js";

describe("parseBuildkitProgress", () => {
  it("parses a numbered build step", () => {
    expect(parseBuildkitProgress("#12 [ 7/15] RUN pnpm install")).toEqual({ step: 7, total: 15 });
  });
  it("parses a stage-named step", () => {
    expect(parseBuildkitProgress("#8 [deps 4/9] COPY . .")).toEqual({ step: 4, total: 9 });
  });
  it("ignores lines without an [x/y] marker", () => {
    expect(parseBuildkitProgress("#3 resolve docker.io/library/node:22-slim")).toBeNull();
    expect(parseBuildkitProgress("=> writing image sha256:abcd")).toBeNull();
    expect(parseBuildkitProgress("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, confirm FAIL**

Run: `pnpm --filter @agenthub/installer exec vitest run buildkit-parse`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// buildkit-parse.ts
/**
 * Parse a BuildKit `--progress=plain` line for its step marker. Lines look like
 * `#12 [ 7/15] RUN ...` or `#8 [stage-name 4/9] COPY ...`. Returns the current
 * step + total layer count, or null when the line carries no step marker.
 */
export function parseBuildkitProgress(line: string): { step: number; total: number } | null {
  // Match the LAST [..x/y] marker on the line (the active layer). The optional
  // leading word(s) is the stage name; \s* tolerates the `[ 7/15]` padding.
  const m = /\[[^\]]*?(\d+)\/(\d+)\]/.exec(line);
  if (!m || !m[1] || !m[2]) return null;
  const step = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isFinite(step) || !Number.isFinite(total) || total <= 0) return null;
  return { step, total };
}
```

- [ ] **Step 4: Run it, confirm PASS.**
- [ ] **Step 5: Commit**

```bash
git add packages/installer/src/lib/engine/buildkit-parse.ts packages/installer/src/lib/engine/buildkit-parse.test.ts
git commit -m "feat(installer): parse BuildKit plain progress lines"
```

> Planning note: verify the marker shape against real `docker build --progress=plain` output on the target Docker (29.x) during execution; the regex tolerates padding + stage names, but confirm before relying on it.

---

### Task 2: Install log file + per-task tail

**Files:** Create `packages/installer/src/lib/engine/log-file.ts` + `.test.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// log-file.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { openInstallLog } from "./log-file.js";

describe("openInstallLog", () => {
  it("writes lines to the file and keeps a per-task tail", () => {
    const log = openInstallLog();
    for (let i = 0; i < 50; i++) log.append("build", `line ${i}`);
    log.append("up", "compose up");
    const onDisk = readFileSync(log.path, "utf8");
    expect(onDisk).toContain("[build] line 49");
    expect(onDisk).toContain("[up] compose up");
    const tail = log.tail("build", 20);
    expect(tail).toHaveLength(20);
    expect(tail.at(-1)).toBe("line 49");
    expect(tail[0]).toBe("line 30");
  });
});
```

- [ ] **Step 2: Run it, confirm FAIL.**

Run: `pnpm --filter @agenthub/installer exec vitest run log-file`

- [ ] **Step 3: Implement**

```typescript
// log-file.ts
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface InstallLog {
  path: string;
  append(taskId: string, line: string): void;
  tail(taskId: string, n?: number): string[];
}

export function openInstallLog(): InstallLog {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(tmpdir(), `agenthub-install-${stamp}.log`);
  const rings = new Map<string, string[]>();
  const KEEP = 60;
  return {
    path,
    append(taskId, line) {
      appendFileSync(path, `[${taskId}] ${line}\n`);
      const ring = rings.get(taskId) ?? [];
      ring.push(line);
      if (ring.length > KEEP) ring.splice(0, ring.length - KEEP);
      rings.set(taskId, ring);
    },
    tail(taskId, n = 20) {
      const ring = rings.get(taskId) ?? [];
      return ring.slice(-n);
    },
  };
}
```

- [ ] **Step 4: Run it, confirm PASS.**
- [ ] **Step 5: Commit**

```bash
git add packages/installer/src/lib/engine/log-file.ts packages/installer/src/lib/engine/log-file.test.ts
git commit -m "feat(installer): timestamped install log with per-task tail"
```

---

### Task 3: Task store

**Files:** Create `packages/installer/src/lib/engine/task-store.ts` + `.test.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// task-store.test.ts
import { describe, it, expect, vi } from "vitest";
import { TaskStore } from "./task-store.js";

describe("TaskStore", () => {
  it("starts queued, transitions, and notifies subscribers", () => {
    const store = new TaskStore([{ id: "server", label: "Build server" }]);
    const cb = vi.fn();
    store.subscribe(cb);
    expect(store.snapshot()[0]?.status).toBe("queued");
    store.setStatus("server", "running");
    store.setProgress("server", 3, 9);
    expect(cb).toHaveBeenCalled();
    const s = store.snapshot()[0];
    expect(s?.status).toBe("running");
    expect(s?.progress).toEqual({ current: 3, total: 9 });
  });

  it("records failure with an error message", () => {
    const store = new TaskStore([{ id: "up", label: "Start services" }]);
    store.fail("up", "compose up exited 1");
    const s = store.snapshot()[0];
    expect(s?.status).toBe("failed");
    expect(s?.error).toBe("compose up exited 1");
  });

  it("snapshot is a copy (immutable to callers)", () => {
    const store = new TaskStore([{ id: "a", label: "A" }]);
    store.snapshot()[0]!.status = "done";
    expect(store.snapshot()[0]?.status).toBe("queued");
  });
});
```

- [ ] **Step 2: Run it, confirm FAIL.**

Run: `pnpm --filter @agenthub/installer exec vitest run task-store`

- [ ] **Step 3: Implement**

```typescript
// task-store.ts
export type TaskStatus = "queued" | "running" | "done" | "failed";

export interface TaskState {
  id: string;
  label: string;
  status: TaskStatus;
  progress?: { current: number; total: number };
  error?: string;
}

export class TaskStore {
  private tasks: TaskState[];
  private subs = new Set<() => void>();

  constructor(initial: { id: string; label: string }[]) {
    this.tasks = initial.map((t) => ({ id: t.id, label: t.label, status: "queued" }));
  }

  snapshot(): TaskState[] {
    return this.tasks.map((t) => ({ ...t, ...(t.progress ? { progress: { ...t.progress } } : {}) }));
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  setStatus(id: string, status: TaskStatus): void {
    this.patch(id, (t) => { t.status = status; });
  }

  setProgress(id: string, current: number, total: number): void {
    this.patch(id, (t) => { t.status = "running"; t.progress = { current, total }; });
  }

  fail(id: string, error: string): void {
    this.patch(id, (t) => { t.status = "failed"; t.error = error; });
  }

  private patch(id: string, fn: (t: TaskState) => void): void {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    fn(t);
    for (const cb of this.subs) cb();
  }
}
```

- [ ] **Step 4: Run it, confirm PASS.**
- [ ] **Step 5: Commit**

```bash
git add packages/installer/src/lib/engine/task-store.ts packages/installer/src/lib/engine/task-store.test.ts
git commit -m "feat(installer): task store for the install engine"
```

---

### Task 4: Docker build runner

**Files:** Create `packages/installer/src/lib/engine/docker-build.ts` + `.test.ts`.

- [ ] **Step 1: Write the failing test (pure arg builder)**

```typescript
// docker-build.test.ts
import { describe, it, expect } from "vitest";
import { dockerBuildArgs } from "./docker-build.js";

describe("dockerBuildArgs", () => {
  it("builds the plain-progress docker build argv", () => {
    expect(
      dockerBuildArgs({ tag: "agenthubv2-server:local", dockerfile: "docker/Dockerfile.server", gitSha: "abc123" }),
    ).toEqual([
      "build", "--progress=plain",
      "--build-arg", "GIT_SHA=abc123",
      "-f", "docker/Dockerfile.server",
      "-t", "agenthubv2-server:local",
      ".",
    ]);
  });
});
```

- [ ] **Step 2: Run it, confirm FAIL.**

Run: `pnpm --filter @agenthub/installer exec vitest run docker-build`

- [ ] **Step 3: Implement**

```typescript
// docker-build.ts
import { spawn } from "node:child_process";
import { parseBuildkitProgress } from "./buildkit-parse.js";

export function dockerBuildArgs(opts: { tag: string; dockerfile: string; gitSha: string }): string[] {
  return [
    "build", "--progress=plain",
    "--build-arg", `GIT_SHA=${opts.gitSha}`,
    "-f", opts.dockerfile,
    "-t", opts.tag,
    ".",
  ];
}

export interface BuildImageOpts {
  tag: string;
  dockerfile: string;
  gitSha: string;
  cwd: string;
  onProgress?: (p: { current: number; total: number }) => void;
  onLine?: (line: string) => void;
}

/** Run `docker build` with BuildKit plain progress. Resolves on exit 0, rejects
 * with the last lines on non-zero. BuildKit writes progress to stderr. */
export function buildImage(opts: BuildImageOpts): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", dockerBuildArgs(opts), {
      cwd: opts.cwd,
      env: { ...process.env, DOCKER_BUILDKIT: "1" },
    });
    const tail: string[] = [];
    const onChunk = (buf: Buffer): void => {
      for (const line of buf.toString().split("\n")) {
        if (!line) continue;
        tail.push(line);
        if (tail.length > 30) tail.shift();
        opts.onLine?.(line);
        const p = parseBuildkitProgress(line);
        if (p) opts.onProgress?.(p);
      }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker build ${opts.tag} failed (exit ${String(code)}):\n${tail.join("\n")}`));
    });
  });
}
```

- [ ] **Step 4: Run it, confirm PASS** (only the pure `dockerBuildArgs` test runs; `buildImage` is exercised manually + in the VM E2E).
- [ ] **Step 5: Commit**

```bash
git add packages/installer/src/lib/engine/docker-build.ts packages/installer/src/lib/engine/docker-build.test.ts
git commit -m "feat(installer): docker build runner with progress parsing"
```

---

### Task 5: Engine orchestration (build specs + bringup)

**Files:** Create `packages/installer/src/lib/engine/install-engine.ts`.

This wires the primitives to the real install. Reuses `run.ts`'s building blocks. Read `run.ts` for the exact bringup sequence (write env, write traefik configs, `composePull`, `composeUp`, `bootstrapInfisical`, `recreateService`).

- [ ] **Step 1: Implement build specs + runBuilds**

```typescript
// install-engine.ts
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildImage } from "./docker-build.js";
import type { InstallLog } from "./log-file.js";
import type { TaskStore } from "./task-store.js";
import type { InstallConfig } from "../config.js";
import { renderEnv } from "../config.js";
import { randomPassword } from "../secrets.js";
import { findComposeDir, writeEnvFile, composePull, composeUp, recreateService } from "../compose.js";
import { bootstrapInfisical } from "../infisical-bootstrap.js";

export interface ImageBuildSpec { id: string; label: string; tag: string; dockerfile: string }

/** Which images need a local build (skip any pinned to a published tag). */
export function imageBuildSpecs(env: NodeJS.ProcessEnv): ImageBuildSpec[] {
  const specs: ImageBuildSpec[] = [];
  if ((env["AGENTHUB_SERVER_IMAGE"] ?? "agenthubv2-server:local") === "agenthubv2-server:local") {
    specs.push({ id: "build-server", label: "Build server image", tag: "agenthubv2-server:local", dockerfile: "docker/Dockerfile.server" });
  }
  if ((env["AGENTHUB_WORKSPACE_IMAGE"] ?? "agenthubv2-workspace:local") === "agenthubv2-workspace:local") {
    specs.push({ id: "build-workspace", label: "Build workspace image", tag: "agenthubv2-workspace:local", dockerfile: "docker/Dockerfile.agent-workspace" });
  }
  specs.push({ id: "build-updater", label: "Build updater image", tag: "agenthubv2-updater:local", dockerfile: "docker/Dockerfile.updater" });
  return specs;
}

export function gitSha(repoDir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
  } catch {
    return "unknown";
  }
}

/** Build all specs in parallel, updating the store + log. Rejects if any fail. */
export async function runBuilds(specs: ImageBuildSpec[], store: TaskStore, log: InstallLog, repoDir: string): Promise<void> {
  const sha = gitSha(repoDir);
  await Promise.all(
    specs.map(async (spec) => {
      store.setStatus(spec.id, "running");
      try {
        await buildImage({
          tag: spec.tag, dockerfile: spec.dockerfile, gitSha: sha, cwd: repoDir,
          onLine: (l) => log.append(spec.id, l),
          onProgress: (p) => store.setProgress(spec.id, p.current, p.total),
        });
        store.setStatus(spec.id, "done");
      } catch (err) {
        store.fail(spec.id, err instanceof Error ? err.message.split("\n")[0]! : String(err));
        throw err;
      }
    }),
  );
}
```

- [ ] **Step 2: Implement runBringup** (append to the same file). Bringup task ids: `config`, `pull`, `up`, `bootstrap`, `recreate`. Mirror `run.ts`'s sequence, wrapping each in store status + log, and reusing the traefik writers (copy the three `writeTraefik*` helpers from `run.ts` into a shared spot OR re-call `runInstall`'s helpers — simplest: import the not-yet-exported writers by exporting them from `run.ts`).

```typescript
export interface InstallArtifacts {
  url: string; adminPassword: string; infisicalAdminEmail: string; infisicalAdminPassword: string;
}

export async function runBringup(cfg: InstallConfig, store: TaskStore, log: InstallLog): Promise<InstallArtifacts> {
  const final: InstallConfig = { ...cfg, adminPassword: cfg.adminPassword || randomPassword(20) };
  const composeDir = findComposeDir();

  store.setStatus("config", "running");
  const envFile = writeEnvFile(final, composeDir);
  writeTraefikConfigs(final, composeDir, (l) => log.append("config", l)); // exported from run.ts (Step 3)
  store.setStatus("config", "done");

  store.setStatus("pull", "running");
  await composePull({ composeDir, envFile, onLine: (l) => log.append("pull", l) });
  store.setStatus("pull", "done");

  store.setStatus("up", "running");
  await composeUp({ composeDir, envFile, onLine: (l) => log.append("up", l) });
  store.setStatus("up", "done");

  store.setStatus("bootstrap", "running");
  const skip = process.env["AGENTHUB_INFISICAL_EXTERNAL"] === "true" || process.env["AGENTHUB_INFISICAL_EXTERNAL"] === "1";
  let post = final;
  if (!skip) {
    const b = await bootstrapInfisical(
      { baseUrl: "http://localhost:8080", adminEmail: "admin@agenthub.local", orgName: "AgentHub", projectName: "agenthub", composeDir, envFile },
      (l) => log.append("bootstrap", l),
    );
    post = { ...final, infisicalProjectId: b.projectId, infisicalClientId: b.clientId, infisicalClientSecret: b.clientSecret, infisicalAdminEmail: b.adminEmail, infisicalAdminPassword: b.adminPassword };
    writeFileSync(envFile, renderEnv(post), { mode: 0o600 });
  }
  store.setStatus("bootstrap", "done");

  store.setStatus("recreate", "running");
  await recreateService({ composeDir, envFile, service: "agenthub-server", onLine: (l) => log.append("recreate", l) });
  store.setStatus("recreate", "done");

  const scheme = final.domain === "localhost" ? "http" : "https";
  return { url: `${scheme}://${final.domain}`, adminPassword: post.adminPassword, infisicalAdminEmail: post.infisicalAdminEmail, infisicalAdminPassword: post.infisicalAdminPassword };
}
```

- [ ] **Step 3: Export the traefik writers from `run.ts`.** In `run.ts`, add a single exported helper that runs the three existing writers:

```typescript
export function writeTraefikConfigs(cfg: InstallConfig, composeDir: string, onLog: (l: string) => void): void {
  writeTraefikConfig(cfg, composeDir, onLog);
  writeTraefikDynamicConfig(cfg, composeDir, onLog);
  writeTraefikOverride(cfg, composeDir, onLog);
}
```
(The three `writeTraefik*` functions already exist as file-locals — just add this exported wrapper. `runInstall` can call it too, replacing its three inline calls — optional, no behavior change.)

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @agenthub/installer typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/installer/src/lib/engine/install-engine.ts packages/installer/src/run.ts
git commit -m "feat(installer): install engine — build specs + bringup tasks"
```

---

## Phase B — UI components

### Task 6: ProgressBar

**Files:** Create `packages/installer/src/components/ProgressBar.tsx`.

- [ ] **Step 1: Implement** (no test harness for Ink; verified via app + manual)

```tsx
import React from "react";
import { Text } from "ink";

export const ProgressBar: React.FC<{ progress?: { current: number; total: number }; width?: number }> = ({ progress, width = 14 }) => {
  if (!progress || progress.total <= 0) {
    return <Text dimColor>working…</Text>;
  }
  const frac = Math.max(0, Math.min(1, progress.current / progress.total));
  const filled = Math.round(frac * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return <Text>{bar} {String(Math.round(frac * 100)).padStart(3)}%  [{progress.current}/{progress.total}]</Text>;
};
```

- [ ] **Step 2: Typecheck** `pnpm --filter @agenthub/installer typecheck`
- [ ] **Step 3: Commit** `git add packages/installer/src/components/ProgressBar.tsx && git commit -m "feat(installer): ProgressBar component"`

---

### Task 7: StepList + BuildPanel

**Files:** Create `packages/installer/src/components/StepList.tsx` and `BuildPanel.tsx`.

- [ ] **Step 1: Implement StepList**

```tsx
// StepList.tsx
import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { TaskState } from "../lib/engine/task-store.js";
import { ProgressBar } from "./ProgressBar.js";

const glyph: Record<TaskState["status"], React.ReactNode> = {
  queued: <Text dimColor>·</Text>,
  running: <Text color="cyan"><Spinner type="dots" /></Text>,
  done: <Text color="green">✓</Text>,
  failed: <Text color="red">✗</Text>,
};

export const StepList: React.FC<{ tasks: TaskState[] }> = ({ tasks }) => (
  <Box flexDirection="column">
    {tasks.map((t) => (
      <Box key={t.id}>
        <Box width={2}>{glyph[t.status]}</Box>
        <Box width={22}><Text>{t.label}</Text></Box>
        {t.status === "running" && <ProgressBar {...(t.progress ? { progress: t.progress } : {})} />}
        {t.status === "done" && <Text dimColor>done</Text>}
        {t.status === "failed" && <Text color="red">{t.error ?? "failed"}</Text>}
      </Box>
    ))}
  </Box>
);
```

- [ ] **Step 2: Implement BuildPanel**

```tsx
// BuildPanel.tsx
import React from "react";
import { Box, Text } from "ink";
import type { TaskState } from "../lib/engine/task-store.js";
import { StepList } from "./StepList.js";

export const BuildPanel: React.FC<{ tasks: TaskState[] }> = ({ tasks }) => {
  if (tasks.length === 0) return null;
  return (
    <Box flexDirection="column" marginLeft={4}>
      <Text bold>Building images</Text>
      <Text dimColor>─────────────────────────────</Text>
      <StepList tasks={tasks} />
    </Box>
  );
};
```

- [ ] **Step 3: Typecheck + Commit**

```bash
pnpm --filter @agenthub/installer typecheck
git add packages/installer/src/components/StepList.tsx packages/installer/src/components/BuildPanel.tsx
git commit -m "feat(installer): StepList + BuildPanel components"
```

---

## Phase C — Integration

### Task 8: Wire engine + builds + run-step into app.tsx

**Files:** Modify `packages/installer/src/app.tsx`.

Read the current `app.tsx` first (step machine `welcome → prereq → mode → … → confirm → run → done`; `RunStep` calls `runInstall`).

- [ ] **Step 1: Add engine state + start builds on mount.** Near the top of `App`, after the existing `useState` hooks, add a stable engine instance and kick builds off once prereqs pass:

```tsx
import { TaskStore, type TaskState } from "./lib/engine/task-store.js";
import { openInstallLog, type InstallLog } from "./lib/engine/log-file.js";
import { imageBuildSpecs, runBuilds, runBringup } from "./lib/engine/install-engine.js";
import { StepList } from "./components/StepList.js";
import { BuildPanel } from "./components/BuildPanel.js";
// ...
const logRef = React.useRef<InstallLog | null>(null);
if (!logRef.current) logRef.current = openInstallLog();
const buildSpecsRef = React.useRef(imageBuildSpecs(process.env));
const buildStoreRef = React.useRef(new TaskStore(buildSpecsRef.current.map((s) => ({ id: s.id, label: s.label }))));
const [buildTasks, setBuildTasks] = useState<TaskState[]>(() => buildStoreRef.current.snapshot());
const [buildError, setBuildError] = useState<string>("");

useEffect(() => {
  const unsub = buildStoreRef.current.subscribe(() => setBuildTasks(buildStoreRef.current.snapshot()));
  return unsub;
}, []);

// Start background builds once, after prereqs pass.
const buildsStarted = React.useRef(false);
useEffect(() => {
  if (step === "prereq" || step === "welcome") return;
  if (buildsStarted.current) return;
  buildsStarted.current = true;
  runBuilds(buildSpecsRef.current, buildStoreRef.current, logRef.current!, process.cwd())
    .catch((err: unknown) => setBuildError(err instanceof Error ? err.message.split("\n")[0]! : "build failed"));
}, [step]);
```

- [ ] **Step 2: Render `BuildPanel` beside config steps.** Wrap the config-step screens so the build panel shows on the right. Simplest: in the `mode`/`domain`/`admin`/etc. return blocks, render inside a shared layout. Add a small wrapper used by those steps:

```tsx
const WithBuilds: React.FC<{ children: React.ReactNode; tasks: TaskState[] }> = ({ children, tasks }) => (
  <Box>
    <Box flexDirection="column">{children}</Box>
    <BuildPanel tasks={tasks} />
  </Box>
);
```
Wrap at least the `mode`, `domain`, `admin`, and `confirm` step returns with `<WithBuilds tasks={buildTasks}>…</WithBuilds>`. (Leave `prereq`/`welcome` as-is.)

- [ ] **Step 3: Block "Install now" until builds are done; surface build failure.** In the `confirm` step's `onSelect` "go" branch, only proceed when builds aren't failed; if `buildError`, show it. Then the `run` step awaits builds inside `runBringup`'s flow. Replace `RunStep` (which called `runInstall`) with an engine-driven version:

```tsx
if (step === "run") {
  return (
    <RunStep
      cfg={cfg}
      log={logRef.current!}
      buildStore={buildStoreRef.current}
      buildSpecs={buildSpecsRef.current}
      onDone={(art) => { setArtifacts(art); setStep("done"); }}
      onError={(msg) => { setError(msg); setStep("done"); }}
    />
  );
}
```

And rewrite `RunStep` to: subscribe to a combined store (build tasks + bringup tasks), `await` builds (already running) then `runBringup`, rendering a unified `StepList`:

```tsx
const BRINGUP = [
  { id: "config", label: "Write config" },
  { id: "pull", label: "Pull images" },
  { id: "up", label: "Start services" },
  { id: "bootstrap", label: "Bootstrap Infisical" },
  { id: "recreate", label: "Restart server" },
];

const RunStep: React.FC<{
  cfg: InstallConfig; log: InstallLog; buildStore: TaskStore; buildSpecs: { id: string; label: string }[];
  onDone: (a: InstallArtifacts) => void; onError: (m: string) => void;
}> = ({ cfg, log, buildStore, buildSpecs, onDone, onError }) => {
  const bringupRef = React.useRef(new TaskStore(BRINGUP));
  const [tasks, setTasks] = useState<TaskState[]>([...buildStore.snapshot(), ...bringupRef.current.snapshot()]);
  useEffect(() => {
    const refresh = () => setTasks([...buildStore.snapshot(), ...bringupRef.current.snapshot()]);
    const u1 = buildStore.subscribe(refresh);
    const u2 = bringupRef.current.subscribe(refresh);
    let cancelled = false;
    (async () => {
      try {
        // builds were started on mount; await their completion via a poll on snapshot status
        await waitForBuilds(buildStore, buildSpecs);
        const art = await runBringup(cfg, bringupRef.current, log);
        if (!cancelled) onDone(art);
      } catch (err) {
        if (!cancelled) onError(failureTail(err, log));
      }
    })();
    return () => { cancelled = true; u1(); u2(); };
  }, [cfg, log, buildStore, buildSpecs, onDone, onError]);
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Installing AgentHub…</Text>
      <StepList tasks={tasks} />
      <Box marginTop={1}><Text dimColor>logs → {log.path}</Text></Box>
    </Box>
  );
};
```

Add the two helpers in `app.tsx`:
```tsx
function waitForBuilds(store: TaskStore, specs: { id: string }[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = (): void => {
      const snap = store.snapshot();
      if (specs.some((s) => snap.find((t) => t.id === s.id)?.status === "failed")) { reject(new Error("image build failed — see log")); return; }
      if (specs.every((s) => snap.find((t) => t.id === s.id)?.status === "done")) { resolve(); return; }
    };
    const unsub = store.subscribe(check);
    check();
    // resolve/reject also clears the subscription
    const wrap = (fn: () => void) => () => { unsub(); fn(); };
    void wrap;
  });
}
function failureTail(err: unknown, log: InstallLog): string {
  const head = err instanceof Error ? err.message : String(err);
  return `${head}\n\nFull log: ${log.path}`;
}
```
(Refine `waitForBuilds` so the subscription is removed on settle — keep a settled flag.)

- [ ] **Step 4: Failure view.** The existing `done` step already renders `error`. Extend it to render multi-line `error` (it already does via `<Text>{error}</Text>`) and ensure the log path shows (included in `failureTail`).

- [ ] **Step 5: Typecheck + manual smoke (local `pnpm --filter @agenthub/installer dev` won't run docker builds meaningfully off-VM; just confirm it compiles + renders the config flow).**

Run: `pnpm --filter @agenthub/installer typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/installer/src/app.tsx
git commit -m "feat(installer): background builds + engine-driven run step in TUI"
```

> Planning note (flagged risk): if `buildStore.subscribe`-driven `setState` fights `TextInput` focus during config, switch the config-screen build panel to a 500ms `setInterval` snapshot poll instead of the subscription. Validate during Step 2–3.

---

### Task 9: Trim install.sh to a quiet bootstrap

**Files:** Modify `scripts/install.sh`.

- [ ] **Step 1: Remove the docker build blocks.** Delete the three `docker build` sections (server/workspace/updater, currently lines ~62–88) — the engine now builds images. Keep computing/ exporting `AGENTHUB_SERVER_IMAGE`/`AGENTHUB_WORKSPACE_IMAGE` (the engine reads them to decide what to build) and keep `GIT_SHA` only if still referenced (the engine recomputes it; remove the now-unused `GIT_SHA=` line).

- [ ] **Step 2: Quiet the pnpm/build output.** Replace:
```bash
echo "=== pnpm install ==="
pnpm install --filter '@agenthub/installer...' --prefer-offline 2>&1 | tail -5
echo "=== building installer ==="
pnpm --filter @agenthub/installer build 2>&1 | tail -3
```
with a clean, log-captured form:
```bash
INSTALL_LOG="${TMPDIR:-/tmp}/agenthub-bootstrap-$(date +%s).log"
printf 'Preparing installer… '
if pnpm install --filter '@agenthub/installer...' --prefer-offline >>"$INSTALL_LOG" 2>&1 \
   && pnpm --filter @agenthub/installer build >>"$INSTALL_LOG" 2>&1; then
  printf 'done\n'
else
  printf 'FAILED\n' >&2
  echo "See $INSTALL_LOG" >&2
  tail -20 "$INSTALL_LOG" >&2
  exit 1
fi
```
Keep the prereq guards (pnpm/docker/daemon checks) and the CLI-install block as-is. Keep the final `exec node packages/installer/dist/index.js "$@"`.

- [ ] **Step 3: Lint** `shellcheck scripts/install.sh && bash -n scripts/install.sh`
- [ ] **Step 4: Commit**

```bash
git add scripts/install.sh
git commit -m "refactor(install): move docker builds into the TUI; quiet bootstrap"
```

---

## Phase D — Verification

### Task 10: Suite + typecheck + manual VM run

- [ ] **Step 1: Unit + typecheck**

Run: `pnpm --filter @agenthub/installer typecheck && pnpm --filter @agenthub/installer test`
Expected: all pass (new engine tests: buildkit-parse, log-file, task-store, docker-build args).

- [ ] **Step 2: Manual VM smoke** (on a fresh VM via the one-liner). Confirm: builds show progress bars in the right-hand panel while you answer config; "Install now" shows the bringup step list; the done screen prints URL + creds; `logs → /tmp/agenthub-install-….log` exists and contains the raw output.

- [ ] **Step 3: Manual failure check** — temporarily break a Dockerfile (or set an invalid base) on the VM, run, and confirm the failed build surfaces the tail + full-log path and blocks "Install now".

- [ ] **Step 4: Commit any fixes** found during manual runs.

---

## Self-Review

**Spec coverage:**
- Phase split (shell bootstrap + TUI owns builds/bringup) → Tasks 5, 8, 9. ✓
- Background builds while configuring → Task 8 (start on mount, `WithBuilds` panel, `waitForBuilds` gate). ✓
- Log to file + failure tail → Task 2 (log-file) + Task 8 (`failureTail`). ✓
- Build-vs-pin skip logic → Task 5 (`imageBuildSpecs`). ✓
- Engine/UI separation → Tasks 1–5 (engine, no React) + 6–7 (components). ✓
- Layout (step list + progress bars + build panel) → Tasks 6, 7, 8. ✓
- Error handling (failed task → tail + log path, blocks install) → Tasks 3, 8. ✓
- Testing (unit on parse/store/log/args; manual for Ink/builds) → Tasks 1–4, 10. ✓

**Placeholder scan:** none — engine code is complete; `app.tsx` integration shows the actual hooks/components/helpers. The two genuinely-uncertain items (BuildKit line shape on Docker 29.x; subscribe-vs-poll focus) are called out as planning notes with concrete fallbacks, not vague TODOs.

**Type consistency:** `TaskState`/`TaskStatus`, `TaskStore` methods (`setStatus`/`setProgress`/`fail`/`snapshot`/`subscribe`), `InstallLog` (`append`/`tail`/`path`), `parseBuildkitProgress`→`{step,total}`, `ProgressBar` prop `{current,total}`, `imageBuildSpecs`/`runBuilds`/`runBringup`/`InstallArtifacts` are used identically across tasks. `runBringup`'s task ids (`config/pull/up/bootstrap/recreate`) match the `BRINGUP` list in Task 8.

**Open risk (flagged, not a gap):** `waitForBuilds` must clear its subscription on settle — Task 8 Step 3 notes the refinement; implement with a `settled` guard.
