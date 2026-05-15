# Agent CLI Auth Integration — Implementation Plan

> **Status:** Implemented in PR #90 (`78a018c`). This file is retained as historical implementation context; do not treat the unchecked task boxes below as current backlog.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-click connect for `claude` / `codex` / `gh` from the Integrations page, using each CLI's own `/login` flow inside an ephemeral auth-helper session. Captured credentials are mirrored to Infisical for cross-volume durability, and the per-user home volume keeps them hot for every session.

**Architecture:** A static registry of supported tools drives a server-side orchestrator that spawns an ephemeral workspace, asks the agent daemon to run the tool's `/login` command, streams the result back to the browser as SSE, and persists the captured credential file to both the per-user volume (free, already mounted) and Infisical (durable mirror). The same orchestrator handles status, disconnect, and hydration on session start.

**Tech Stack:** Hono routes (SSE), Drizzle + better-sqlite3, ws (existing per-session agent WebSocket), Infisical SDK, React 19 + Vite (web), vitest (tests).

**Spec:** `docs/superpowers/specs/2026-05-14-agent-cli-auth-integration-design.md` (commit `9c5660e`).

---

## File Structure

| File | Responsibility |
|---|---|
| **Server — new** | |
| `packages/server/src/services/agent-auth/registry.ts` | Static `AgentTool[]` + lookup helpers |
| `packages/server/src/services/agent-auth/registry.test.ts` | Registry validation tests + URL-pattern fixtures |
| `packages/server/src/services/agent-auth/paths.ts` | Infisical path helpers (`buildPath(userId, toolId)`) |
| `packages/server/src/services/agent-auth/paths.test.ts` | Path-construction tests |
| `packages/server/src/services/agent-auth/orchestrator.ts` | Connect/disconnect/status state machines |
| `packages/server/src/services/agent-auth/orchestrator.test.ts` | Full WS roundtrip with fake daemon |
| `packages/server/src/services/agent-auth/credential-sync.ts` | Hydration on session-active |
| `packages/server/src/services/agent-auth/audit.ts` | Audit log writer |
| `packages/server/src/services/agent-auth/audit.test.ts` | Audit row inserts |
| `packages/server/src/services/agent-auth/__fixtures__/claude-login-stdout.txt` | Real `claude /login` output for URL-pattern tests |
| `packages/server/src/services/agent-auth/__fixtures__/codex-login-stdout.txt` | Real `codex login` output |
| `packages/server/src/services/agent-auth/__fixtures__/gh-auth-stdout.txt` | Real `gh auth login --web` output |
| `packages/server/src/routes/integrations-agents.ts` | List/connect-SSE/disconnect/refresh |
| `packages/server/src/routes/admin-agent-auth.ts` | Audit log + registry-view admin endpoints |
| **Server — modified** | |
| `packages/server/src/db/schema.ts` | Add `agentAuthAudit` Drizzle table |
| `packages/server/src/db/index.ts` | Add `CREATE TABLE IF NOT EXISTS agent_auth_audit` to `initDb()` |
| `packages/server/src/services/session-manager.ts` | Add `createAuthHelperSession()`; post-active hydration hook |
| `packages/server/src/index.ts` | Mount the two new routers |
| **Agent daemon — new** | |
| `packages/agent/src/auth/handler.ts` | WS-side handlers for `auth.connect`/`disconnect`/`cancel`/`hydrate` |
| `packages/agent/src/auth/cred-watcher.ts` | `fs.watch` on registered credential paths, ship to server |
| `packages/agent/src/auth/protocol.ts` | Shared message types (mirrored in server) |
| **Agent daemon — modified** | |
| `packages/agent/src/ws-server.ts` | Route `auth.*` messages to `handler.ts`; expose `send()` to handler/watcher |
| `packages/agent/src/index.ts` | Wire the handler + start cred-watcher on daemon boot |
| **Web — new** | |
| `packages/web/src/components/agent-auth/AgentCard.tsx` | One card per tool — status + actions |
| `packages/web/src/components/agent-auth/AgentLoginModal.tsx` | SSE-driven connect modal |
| `packages/web/src/components/agent-auth/useAgentStatus.ts` | Hook: poll `GET /api/integrations/agents` |
| `packages/web/src/pages/admin/AgentAuthAudit.tsx` | Admin audit log viewer |
| **Web — modified** | |
| `packages/web/src/pages/Integrations.tsx` | Add "Agent CLIs" section above existing AI providers |
| `packages/web/src/pages/admin/...` (existing admin router) | Mount new audit page |
| **Tests / fixtures — new** | |
| `packages/server/test/fixtures/fake-cli/fake-claude.sh` | Bash script that prints a known URL and writes a known credential file |
| `scripts/e2e-full.js` (modified) | Add agent-auth connect/disconnect smoke test |
| `docs/operations/agent-auth-verification.md` | Manual verification doc for live Anthropic/OpenAI/GitHub OAuth |

---

## Phase 1 — Foundation (registry, paths, audit)

### Task 1.1: Tool registry types and the first entry (`claude-code`)

**Files:**
- Create: `packages/server/src/services/agent-auth/registry.ts`
- Create: `packages/server/src/services/agent-auth/registry.test.ts`
- Create: `packages/server/src/services/agent-auth/__fixtures__/claude-login-stdout.txt`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/services/agent-auth/__fixtures__/claude-login-stdout.txt` with the literal stdout that real `claude /login` prints (capture from a real run; if unavailable, use the following placeholder pattern that real Claude Code is known to emit):

```
Opening browser at:
https://claude.ai/oauth/authorize?response_type=code&client_id=cli&redirect_uri=http%3A%2F%2Flocalhost%3A55001%2Fcallback&code_challenge=abc123&code_challenge_method=S256&state=xyz789
Waiting for callback on http://localhost:55001 ...
```

Create `packages/server/src/services/agent-auth/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_TOOLS, getTool } from "./registry.js";

const fixtureDir = join(__dirname, "__fixtures__");

describe("agent tool registry", () => {
  it("has unique IDs", () => {
    const ids = AGENT_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("getTool returns the entry for claude-code", () => {
    const tool = getTool("claude-code");
    expect(tool?.displayName).toBe("Claude Code");
    expect(tool?.loginCommand).toBe("claude /login");
    expect(tool?.credentialPaths).toEqual(["/home/coder/.claude/.credentials.json"]);
  });

  it("getTool returns undefined for unknown id", () => {
    expect(getTool("nope")).toBeUndefined();
  });

  it("claude-code urlPattern matches its fixture stdout", () => {
    const tool = getTool("claude-code")!;
    const stdout = readFileSync(join(fixtureDir, "claude-login-stdout.txt"), "utf8");
    const match = stdout.match(tool.urlPattern);
    expect(match).not.toBeNull();
    expect(match![0]).toContain("claude.ai/oauth/authorize");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/agent-auth/registry.test.ts`
Expected: FAIL with "Failed to resolve import './registry.js'".

- [ ] **Step 3: Implement the registry**

Create `packages/server/src/services/agent-auth/registry.ts`:

```ts
export interface AgentTool {
  id: string;
  displayName: string;
  loginCommand: string;
  logoutCommand?: string;
  credentialPaths: string[];
  urlPattern: RegExp;
  loginTimeoutSec: number;
  expiryParser?: (fileContents: string) => Date | null;
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    loginCommand: "claude /login",
    logoutCommand: "claude /logout",
    credentialPaths: ["/home/coder/.claude/.credentials.json"],
    urlPattern: /https:\/\/claude\.ai\/oauth\/authorize\?[^\s]+/,
    loginTimeoutSec: 300,
    expiryParser: parseClaudeExpiry,
  },
];

export function getTool(id: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.id === id);
}

function parseClaudeExpiry(contents: string): Date | null {
  try {
    const parsed = JSON.parse(contents) as { expiresAt?: number; expires_at?: number };
    const epochMs = parsed.expiresAt ?? parsed.expires_at;
    return typeof epochMs === "number" ? new Date(epochMs) : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/agent-auth/registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/agent-auth/
git commit -m "$(cat <<'EOF'
feat(agent-auth): tool registry with claude-code entry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.2: Add `codex` and `gh` to the registry

**Files:**
- Modify: `packages/server/src/services/agent-auth/registry.ts`
- Modify: `packages/server/src/services/agent-auth/registry.test.ts`
- Create: `packages/server/src/services/agent-auth/__fixtures__/codex-login-stdout.txt`
- Create: `packages/server/src/services/agent-auth/__fixtures__/gh-auth-stdout.txt`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/services/agent-auth/__fixtures__/codex-login-stdout.txt`:

```
Open this URL in your browser to log in:
https://auth.openai.com/authorize?client_id=codex-cli&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback&state=abc
```

Create `packages/server/src/services/agent-auth/__fixtures__/gh-auth-stdout.txt`:

```
! First copy your one-time code: ABCD-1234
- Press Enter to open https://github.com/login/device in your browser...
```

Append to `registry.test.ts`:

```ts
describe("codex tool", () => {
  it("is registered with the right login command", () => {
    const tool = getTool("codex")!;
    expect(tool.loginCommand).toBe("codex login");
    expect(tool.credentialPaths).toEqual(["/home/coder/.codex/auth.json"]);
  });

  it("urlPattern matches codex stdout fixture", () => {
    const tool = getTool("codex")!;
    const stdout = readFileSync(join(fixtureDir, "codex-login-stdout.txt"), "utf8");
    const match = stdout.match(tool.urlPattern);
    expect(match).not.toBeNull();
    expect(match![0]).toContain("auth.openai.com");
  });
});

describe("gh tool", () => {
  it("is registered with the right login command", () => {
    const tool = getTool("gh")!;
    expect(tool.loginCommand).toBe("gh auth login --web --hostname github.com");
    expect(tool.credentialPaths).toContain("/home/coder/.config/gh/hosts.yml");
  });

  it("urlPattern matches gh stdout fixture", () => {
    const tool = getTool("gh")!;
    const stdout = readFileSync(join(fixtureDir, "gh-auth-stdout.txt"), "utf8");
    expect(stdout).toMatch(tool.urlPattern);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/agent-auth/registry.test.ts`
Expected: FAIL ("Cannot read properties of undefined" on `getTool("codex")`).

- [ ] **Step 3: Add the entries**

Extend `AGENT_TOOLS` in `registry.ts`:

```ts
  {
    id: "codex",
    displayName: "OpenAI Codex",
    loginCommand: "codex login",
    credentialPaths: ["/home/coder/.codex/auth.json"],
    urlPattern: /https:\/\/auth\.openai\.com\/[^\s]+/,
    loginTimeoutSec: 300,
  },
  {
    id: "gh",
    displayName: "GitHub CLI",
    loginCommand: "gh auth login --web --hostname github.com",
    logoutCommand: "gh auth logout --hostname github.com",
    credentialPaths: [
      "/home/coder/.config/gh/hosts.yml",
    ],
    urlPattern: /https:\/\/github\.com\/login\/device/,
    loginTimeoutSec: 300,
  },
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/agent-auth/registry.test.ts`
Expected: PASS (now 8 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/agent-auth/
git commit -m "$(cat <<'EOF'
feat(agent-auth): add codex and gh registry entries

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.3: Infisical path helpers

**Files:**
- Create: `packages/server/src/services/agent-auth/paths.ts`
- Create: `packages/server/src/services/agent-auth/paths.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/services/agent-auth/paths.test.ts
import { describe, expect, it } from "vitest";
import { agentCredentialPath, validateUserId, validateToolId } from "./paths.js";

describe("agent-auth paths", () => {
  it("builds the per-user per-tool credential path", () => {
    expect(agentCredentialPath("user-abc", "claude-code"))
      .toBe("/users/user-abc/agents/claude-code");
  });

  it("rejects user IDs with path traversal characters", () => {
    expect(() => validateUserId("../etc")).toThrow();
    expect(() => validateUserId("user/abc")).toThrow();
    expect(() => validateUserId("user abc")).toThrow();
  });

  it("rejects tool IDs that aren't kebab-case alphanum", () => {
    expect(() => validateToolId("Claude Code")).toThrow();
    expect(() => validateToolId("../oops")).toThrow();
    expect(validateToolId("claude-code")).toBe("claude-code");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/agent-auth/paths.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/server/src/services/agent-auth/paths.ts
const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TOOL_ID_RE = /^[a-z0-9-]{1,64}$/;

export function validateUserId(userId: string): string {
  if (!USER_ID_RE.test(userId)) throw new Error(`invalid userId: ${userId}`);
  return userId;
}

export function validateToolId(toolId: string): string {
  if (!TOOL_ID_RE.test(toolId)) throw new Error(`invalid toolId: ${toolId}`);
  return toolId;
}

export function agentCredentialPath(userId: string, toolId: string): string {
  return `/users/${validateUserId(userId)}/agents/${validateToolId(toolId)}`;
}

export const CREDENTIAL_SECRET_NAME = "credentials";
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/agent-auth/paths.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/agent-auth/paths.ts packages/server/src/services/agent-auth/paths.test.ts
git commit -m "feat(agent-auth): per-user Infisical path helpers with validation"
```

---

### Task 1.4: SQLite audit table

**Files:**
- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/db/index.ts`

- [ ] **Step 1: Add the Drizzle schema definition**

Append to `packages/server/src/db/schema.ts`:

```ts
export const agentAuthAudit = sqliteTable("agent_auth_audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: integer("ts").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  action: text("action", {
    enum: ["connect", "disconnect", "refresh", "hydrate", "capture"],
  }).notNull(),
  toolId: text("tool_id").notNull(),
  sessionId: text("session_id"),
  ok: integer("ok", { mode: "boolean" }).notNull().default(true),
  error: text("error"),
});
```

- [ ] **Step 2: Add the table-create SQL to `initDb()`**

Append the following block to the big `sqlite.exec(...)` template in `packages/server/src/db/index.ts`, before the closing backtick:

```sql
    CREATE TABLE IF NOT EXISTS agent_auth_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      session_id TEXT,
      ok INTEGER NOT NULL DEFAULT 1,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_auth_audit_user_ts ON agent_auth_audit(user_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_auth_audit_tool ON agent_auth_audit(tool_id, ts DESC);
```

- [ ] **Step 3: Verify schema typechecks**

Run: `pnpm --filter @agenthub/server typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/db/
git commit -m "feat(agent-auth): add agent_auth_audit table for connect/disconnect history"
```

---

### Task 1.5: Audit writer service

**Files:**
- Create: `packages/server/src/services/agent-auth/audit.ts`
- Create: `packages/server/src/services/agent-auth/audit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/services/agent-auth/audit.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { writeAudit, listAudit } from "./audit.js";
import * as schema from "../../db/schema.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, password_hash TEXT, display_name TEXT, role TEXT, created_at INTEGER);
    INSERT INTO users (id, username, password_hash, display_name, role, created_at) VALUES ('u1', 'alice', 'x', 'Alice', 'user', 0);
    CREATE TABLE agent_auth_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      session_id TEXT,
      ok INTEGER NOT NULL DEFAULT 1,
      error TEXT
    );
  `);
  return drizzle(sqlite, { schema });
}

describe("agent-auth audit", () => {
  it("writes a row and reads it back ordered newest first", async () => {
    const db = makeDb();
    await writeAudit(db, { userId: "u1", action: "connect", toolId: "claude-code", sessionId: "s1", ok: true });
    await writeAudit(db, { userId: "u1", action: "capture", toolId: "claude-code", sessionId: "s1", ok: true });

    const rows = await listAudit(db, { userId: "u1", limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows[0].action).toBe("capture");
    expect(rows[1].action).toBe("connect");
  });

  it("records ok=false and error message on failures", async () => {
    const db = makeDb();
    await writeAudit(db, { userId: "u1", action: "connect", toolId: "codex", ok: false, error: "timeout" });
    const rows = await listAudit(db, { userId: "u1", limit: 10 });
    expect(rows[0].ok).toBe(false);
    expect(rows[0].error).toBe("timeout");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/agent-auth/audit.test.ts`
Expected: FAIL (no `audit.js`).

- [ ] **Step 3: Implement**

```ts
// packages/server/src/services/agent-auth/audit.ts
import { desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { agentAuthAudit } from "../../db/schema.js";

export type AuditAction = "connect" | "disconnect" | "refresh" | "hydrate" | "capture";

export interface AuditEntry {
  userId: string;
  action: AuditAction;
  toolId: string;
  sessionId?: string;
  ok: boolean;
  error?: string;
}

export interface AuditRow extends AuditEntry {
  id: number;
  ts: number;
}

export async function writeAudit(
  db: BetterSQLite3Database<Record<string, unknown>>,
  entry: AuditEntry,
): Promise<void> {
  await db.insert(agentAuthAudit).values({
    ts: Date.now(),
    userId: entry.userId,
    action: entry.action,
    toolId: entry.toolId,
    sessionId: entry.sessionId,
    ok: entry.ok,
    error: entry.error,
  });
}

export async function listAudit(
  db: BetterSQLite3Database<Record<string, unknown>>,
  opts: { userId: string; limit: number },
): Promise<AuditRow[]> {
  const rows = await db
    .select()
    .from(agentAuthAudit)
    .where(eq(agentAuthAudit.userId, opts.userId))
    .orderBy(desc(agentAuthAudit.ts))
    .limit(opts.limit);
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    userId: r.userId,
    action: r.action as AuditAction,
    toolId: r.toolId,
    sessionId: r.sessionId ?? undefined,
    ok: Boolean(r.ok),
    error: r.error ?? undefined,
  }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/agent-auth/audit.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/agent-auth/audit.ts packages/server/src/services/agent-auth/audit.test.ts
git commit -m "feat(agent-auth): audit writer and listAudit helper"
```

---

## Phase 2 — Agent daemon: auth handlers + cred-watcher

### Task 2.1: Define shared auth protocol types

**Files:**
- Create: `packages/agent/src/auth/protocol.ts`

- [ ] **Step 1: Implement (no test — pure type module)**

```ts
// packages/agent/src/auth/protocol.ts
export type AuthInbound =
  | { type: "auth.connect"; tool: string; loginCommand: string; urlPattern: string; timeoutSec: number }
  | { type: "auth.cancel"; tool: string }
  | { type: "auth.disconnect"; tool: string; logoutCommand?: string; credentialPaths: string[] }
  | { type: "auth.hydrate"; entries: Array<{ tool: string; path: string; contentsBase64: string }> }
  | { type: "auth.hydrateProbe"; tools: Array<{ tool: string; paths: string[] }> };

export type AuthOutbound =
  | { type: "auth.line"; tool: string; stream: "stdout" | "stderr"; line: string }
  | { type: "auth.captured"; tool: string; path: string; contentsBase64: string }
  | { type: "auth.done"; tool: string; ok: boolean; error?: string }
  | { type: "auth.disconnected"; tool: string; ok: boolean; error?: string }
  | { type: "auth.hydrateProbeResult"; missing: Array<{ tool: string; path: string }> };
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm --filter @agenthub/agent typecheck`
Expected: PASS (no test, but file must compile).

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/auth/protocol.ts
git commit -m "feat(agent-auth): shared WS protocol types for auth flow"
```

---

### Task 2.2: Auth handler — connect (spawn loginCommand, stream output)

**Files:**
- Create: `packages/agent/src/auth/handler.ts`
- Create: `packages/agent/src/auth/handler.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent/src/auth/handler.test.ts
import { describe, expect, it, vi } from "vitest";
import { AuthHandler } from "./handler.js";
import type { AuthOutbound } from "./protocol.js";

describe("AuthHandler.connect", () => {
  it("spawns the login command and streams stdout lines back", async () => {
    const sent: AuthOutbound[] = [];
    const handler = new AuthHandler({
      send: (msg) => { sent.push(msg); },
      spawn: () => ({
        stdoutLines: (async function* () {
          yield "Visit https://example.com/auth?state=abc to log in";
          yield "Waiting...";
        })(),
        stderrLines: (async function* () {})(),
        kill: vi.fn(),
        wait: () => Promise.resolve(0),
      }),
    });

    await handler.handle({
      type: "auth.connect",
      tool: "claude-code",
      loginCommand: "claude /login",
      urlPattern: "https://example.com/[^\\s]+",
      timeoutSec: 5,
    });

    const lines = sent.filter((m) => m.type === "auth.line");
    expect(lines).toHaveLength(2);
    expect((lines[0] as { line: string }).line).toContain("example.com");

    const done = sent.find((m) => m.type === "auth.done");
    expect(done).toBeDefined();
    expect((done as { ok: boolean }).ok).toBe(true);
  });

  it("reports ok=false on non-zero exit", async () => {
    const sent: AuthOutbound[] = [];
    const handler = new AuthHandler({
      send: (msg) => { sent.push(msg); },
      spawn: () => ({
        stdoutLines: (async function* () { yield "error: not authenticated"; })(),
        stderrLines: (async function* () {})(),
        kill: vi.fn(),
        wait: () => Promise.resolve(1),
      }),
    });
    await handler.handle({
      type: "auth.connect",
      tool: "claude-code",
      loginCommand: "claude /login",
      urlPattern: "https://example\\.com/[^\\s]+",
      timeoutSec: 5,
    });
    const done = sent.find((m) => m.type === "auth.done") as { ok: boolean; error?: string };
    expect(done.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agenthub/agent exec vitest run src/auth/handler.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the handler**

```ts
// packages/agent/src/auth/handler.ts
import { spawn as nodeSpawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { AuthInbound, AuthOutbound } from "./protocol.js";

export interface ProcessHandle {
  stdoutLines: AsyncIterable<string>;
  stderrLines: AsyncIterable<string>;
  kill: () => void;
  wait: () => Promise<number>;
}

export interface AuthHandlerDeps {
  send: (msg: AuthOutbound) => void;
  spawn?: (command: string) => ProcessHandle;
}

export class AuthHandler {
  private readonly deps: Required<AuthHandlerDeps>;
  private active = new Map<string, { kill: () => void }>();

  constructor(deps: AuthHandlerDeps) {
    this.deps = { spawn: realSpawn, ...deps };
  }

  async handle(msg: AuthInbound): Promise<void> {
    switch (msg.type) {
      case "auth.connect":
        await this.connect(msg);
        return;
      case "auth.cancel":
        this.cancel(msg.tool);
        return;
      case "auth.disconnect":
      case "auth.hydrate":
      case "auth.hydrateProbe":
        // Implemented in later tasks.
        return;
    }
  }

  private cancel(tool: string): void {
    const entry = this.active.get(tool);
    if (entry) entry.kill();
  }

  private async connect(msg: Extract<AuthInbound, { type: "auth.connect" }>): Promise<void> {
    const { send } = this.deps;
    const proc = this.deps.spawn(msg.loginCommand);
    this.active.set(msg.tool, { kill: proc.kill });

    const consume = async (
      iter: AsyncIterable<string>,
      stream: "stdout" | "stderr",
    ): Promise<void> => {
      for await (const line of iter) {
        send({ type: "auth.line", tool: msg.tool, stream, line });
      }
    };

    const timeout = setTimeout(() => proc.kill(), msg.timeoutSec * 1000);
    try {
      await Promise.all([consume(proc.stdoutLines, "stdout"), consume(proc.stderrLines, "stderr")]);
      const code = await proc.wait();
      send({ type: "auth.done", tool: msg.tool, ok: code === 0, error: code === 0 ? undefined : `exit ${code}` });
    } finally {
      clearTimeout(timeout);
      this.active.delete(msg.tool);
    }
  }
}

function realSpawn(command: string): ProcessHandle {
  // Run as `coder` user via `su -l coder -c <command>` only when we're root.
  // In tests `spawn` is overridden, so this branch only runs in production.
  const argv = process.getuid && process.getuid() === 0
    ? ["su", "-l", "coder", "-c", command]
    : ["sh", "-c", command];
  const proc = nodeSpawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });

  return {
    stdoutLines: linesOf(proc.stdout!),
    stderrLines: linesOf(proc.stderr!),
    kill: () => proc.kill("SIGTERM"),
    wait: () => new Promise((resolve) => proc.on("exit", (code) => resolve(code ?? 1))),
  };
}

async function* linesOf(stream: NodeJS.ReadableStream): AsyncIterable<string> {
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.length) yield buf;
}

export async function readCredentialFile(path: string): Promise<string> {
  const buf = await readFile(path);
  return buf.toString("base64");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @agenthub/agent exec vitest run src/auth/handler.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/auth/handler.ts packages/agent/src/auth/handler.test.ts
git commit -m "feat(agent-auth): daemon auth handler with subprocess streaming"
```

---

### Task 2.3: Auth handler — disconnect

**Files:**
- Modify: `packages/agent/src/auth/handler.ts`
- Modify: `packages/agent/src/auth/handler.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `handler.test.ts`:

```ts
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("AuthHandler.disconnect", () => {
  it("runs logoutCommand if provided", async () => {
    const sent: AuthOutbound[] = [];
    const handler = new AuthHandler({
      send: (m) => sent.push(m),
      spawn: () => ({
        stdoutLines: (async function* () {})(),
        stderrLines: (async function* () {})(),
        kill: vi.fn(),
        wait: () => Promise.resolve(0),
      }),
    });
    await handler.handle({
      type: "auth.disconnect",
      tool: "claude-code",
      logoutCommand: "claude /logout",
      credentialPaths: [],
    });
    const done = sent.find((m) => m.type === "auth.disconnected") as { ok: boolean };
    expect(done.ok).toBe(true);
  });

  it("deletes credential files when no logoutCommand", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentauth-"));
    const credFile = join(dir, "creds.json");
    writeFileSync(credFile, "{\"x\":1}");
    expect(existsSync(credFile)).toBe(true);

    const sent: AuthOutbound[] = [];
    const handler = new AuthHandler({ send: (m) => sent.push(m) });
    await handler.handle({
      type: "auth.disconnect",
      tool: "test",
      credentialPaths: [credFile],
    });
    expect(existsSync(credFile)).toBe(false);
    const done = sent.find((m) => m.type === "auth.disconnected") as { ok: boolean };
    expect(done.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agenthub/agent exec vitest run src/auth/handler.test.ts -t "disconnect"`
Expected: FAIL.

- [ ] **Step 3: Implement the disconnect branch**

Replace the `case "auth.disconnect":` line in `handle()` with:

```ts
      case "auth.disconnect":
        await this.disconnect(msg);
        return;
```

Add the method:

```ts
  private async disconnect(msg: Extract<AuthInbound, { type: "auth.disconnect" }>): Promise<void> {
    try {
      if (msg.logoutCommand) {
        const proc = this.deps.spawn(msg.logoutCommand);
        // Drain output but don't forward — disconnect is silent to the UI.
        const drain = async (i: AsyncIterable<string>) => { for await (const _ of i) { /* drop */ } };
        await Promise.all([drain(proc.stdoutLines), drain(proc.stderrLines)]);
        await proc.wait();
      }
      const { unlink } = await import("node:fs/promises");
      for (const p of msg.credentialPaths) {
        await unlink(p).catch(() => undefined);
      }
      this.deps.send({ type: "auth.disconnected", tool: msg.tool, ok: true });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.deps.send({ type: "auth.disconnected", tool: msg.tool, ok: false, error });
    }
  }
```

- [ ] **Step 4: Run to verify**

Run: `pnpm --filter @agenthub/agent exec vitest run src/auth/handler.test.ts`
Expected: PASS (4 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/auth/handler.test.ts packages/agent/src/auth/handler.ts
git commit -m "feat(agent-auth): daemon disconnect handler"
```

---

### Task 2.4: Auth handler — hydrate + hydrateProbe

**Files:**
- Modify: `packages/agent/src/auth/handler.ts`
- Modify: `packages/agent/src/auth/handler.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("AuthHandler.hydrate", () => {
  it("writes hydrate entries to disk with 0600 perms", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentauth-h-"));
    const credFile = join(dir, "subdir", "creds.json");
    const sent: AuthOutbound[] = [];
    const handler = new AuthHandler({ send: (m) => sent.push(m) });

    const contents = Buffer.from("{\"hello\":\"world\"}");
    await handler.handle({
      type: "auth.hydrate",
      entries: [{ tool: "test", path: credFile, contentsBase64: contents.toString("base64") }],
    });

    const { readFileSync, statSync } = await import("node:fs");
    expect(readFileSync(credFile, "utf8")).toBe("{\"hello\":\"world\"}");
    const stat = statSync(credFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("hydrateProbe reports which paths are missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentauth-p-"));
    const present = join(dir, "present.json");
    writeFileSync(present, "x");
    const missing = join(dir, "missing.json");

    const sent: AuthOutbound[] = [];
    const handler = new AuthHandler({ send: (m) => sent.push(m) });
    await handler.handle({
      type: "auth.hydrateProbe",
      tools: [{ tool: "test", paths: [present, missing] }],
    });

    const result = sent.find((m) => m.type === "auth.hydrateProbeResult") as { missing: Array<{ tool: string; path: string }> };
    expect(result.missing).toEqual([{ tool: "test", path: missing }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agenthub/agent exec vitest run src/auth/handler.test.ts -t "hydrate"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Replace the `case "auth.hydrate":` and `case "auth.hydrateProbe":` lines with:

```ts
      case "auth.hydrate":
        await this.hydrate(msg);
        return;
      case "auth.hydrateProbe":
        await this.hydrateProbe(msg);
        return;
```

Add the methods:

```ts
  private async hydrate(msg: Extract<AuthInbound, { type: "auth.hydrate" }>): Promise<void> {
    const { mkdir, writeFile, chmod } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    for (const entry of msg.entries) {
      await mkdir(dirname(entry.path), { recursive: true, mode: 0o700 });
      await writeFile(entry.path, Buffer.from(entry.contentsBase64, "base64"));
      await chmod(entry.path, 0o600);
    }
  }

  private async hydrateProbe(msg: Extract<AuthInbound, { type: "auth.hydrateProbe" }>): Promise<void> {
    const { access } = await import("node:fs/promises");
    const missing: Array<{ tool: string; path: string }> = [];
    for (const t of msg.tools) {
      for (const p of t.paths) {
        try { await access(p); } catch { missing.push({ tool: t.tool, path: p }); }
      }
    }
    this.deps.send({ type: "auth.hydrateProbeResult", missing });
  }
```

- [ ] **Step 4: Run to verify**

Run: `pnpm --filter @agenthub/agent exec vitest run src/auth/handler.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/auth/
git commit -m "feat(agent-auth): daemon hydrate + hydrateProbe handlers"
```

---

### Task 2.5: Credential watcher (fs.watch + debounce)

**Files:**
- Create: `packages/agent/src/auth/cred-watcher.ts`
- Create: `packages/agent/src/auth/cred-watcher.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent/src/auth/cred-watcher.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialWatcher } from "./cred-watcher.js";
import type { AuthOutbound } from "./protocol.js";

describe("CredentialWatcher", () => {
  it("emits auth.captured when a watched path is written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "credw-"));
    const target = join(dir, "creds.json");
    const sent: AuthOutbound[] = [];
    const watcher = new CredentialWatcher({
      send: (m) => sent.push(m),
      debounceMs: 30,
      tools: [{ tool: "test", paths: [target] }],
    });
    watcher.start();
    writeFileSync(target, "{\"a\":1}");
    await new Promise((r) => setTimeout(r, 120));
    watcher.stop();

    const captured = sent.find((m) => m.type === "auth.captured") as { tool: string; path: string; contentsBase64: string };
    expect(captured.tool).toBe("test");
    expect(captured.path).toBe(target);
    expect(Buffer.from(captured.contentsBase64, "base64").toString()).toBe("{\"a\":1}");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agenthub/agent exec vitest run src/auth/cred-watcher.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/agent/src/auth/cred-watcher.ts
import { watch, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuthOutbound } from "./protocol.js";

export interface WatcherDeps {
  send: (msg: AuthOutbound) => void;
  debounceMs?: number;
  tools: Array<{ tool: string; paths: string[] }>;
}

export class CredentialWatcher {
  private readonly deps: Required<WatcherDeps>;
  private controllers: AbortController[] = [];
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(deps: WatcherDeps) {
    this.deps = { debounceMs: 5000, ...deps };
  }

  start(): void {
    for (const t of this.deps.tools) {
      for (const p of t.paths) {
        this.watchOne(t.tool, p);
      }
    }
  }

  stop(): void {
    for (const c of this.controllers) c.abort();
    this.controllers = [];
    for (const tm of this.timers.values()) clearTimeout(tm);
    this.timers.clear();
  }

  private watchOne(tool: string, path: string): void {
    const ctrl = new AbortController();
    this.controllers.push(ctrl);
    void (async () => {
      try {
        await mkdir(dirname(path), { recursive: true });
        const watcher = watch(dirname(path), { signal: ctrl.signal });
        for await (const ev of watcher) {
          if (!ev.filename) continue;
          const full = `${dirname(path)}/${ev.filename}`;
          if (full !== path) continue;
          this.scheduleEmit(tool, path);
        }
      } catch (err) {
        if ((err as { name?: string }).name !== "AbortError") {
          console.warn(`[cred-watcher] ${path} failed: ${(err as Error).message}`);
        }
      }
    })();
  }

  private scheduleEmit(tool: string, path: string): void {
    const existing = this.timers.get(path);
    if (existing) clearTimeout(existing);
    const tm = setTimeout(async () => {
      this.timers.delete(path);
      try {
        const buf = await readFile(path);
        this.deps.send({ type: "auth.captured", tool, path, contentsBase64: buf.toString("base64") });
      } catch {
        // file vanished between fire and read — ignore
      }
    }, this.deps.debounceMs);
    this.timers.set(path, tm);
  }
}
```

- [ ] **Step 4: Run to verify**

Run: `pnpm --filter @agenthub/agent exec vitest run src/auth/cred-watcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/auth/cred-watcher.ts packages/agent/src/auth/cred-watcher.test.ts
git commit -m "feat(agent-auth): credential file watcher with debounce"
```

---

### Task 2.6: Wire handler + watcher into the agent WS server

**Files:**
- Modify: `packages/agent/src/ws-server.ts`
- Modify: `packages/agent/src/index.ts`

- [ ] **Step 1: Modify `ws-server.ts` to accept and route auth messages**

In `packages/agent/src/ws-server.ts`:

1. Extend `InboundMessage`:

```ts
import type { AuthInbound, AuthOutbound } from "./auth/protocol.js";

type InboundMessage =
  | { type: "start" }
  | { type: "upload"; name: string; data: string }
  | { type: "stop" }
  | { type: "backup"; op: "save" | "restore" | "size"; requestId: string; params: BackupParams }
  | { type: "package"; op: "install" | "remove"; requestId: string; params: PackageOpParams }
  | AuthInbound;
```

2. Extend `OutboundMessage` union with `AuthOutbound`.

3. Add a public `send` and a `setAuthHandler` so `handler.ts` can be wired from outside:

```ts
  public send(msg: OutboundMessage): void {
    const c = this.client;
    if (c && c.readyState === c.OPEN) c.send(JSON.stringify(msg));
  }

  private authRouter: ((msg: AuthInbound) => Promise<void>) | null = null;
  public setAuthRouter(fn: (msg: AuthInbound) => Promise<void>): void {
    this.authRouter = fn;
  }
```

4. In `handleMessage`, before the existing switch, add:

```ts
  private handleMessage(msg: InboundMessage): void {
    if (typeof (msg as { type?: string }).type === "string" && (msg as { type: string }).type.startsWith("auth.")) {
      void this.authRouter?.(msg as AuthInbound);
      return;
    }
    // ...existing switch
  }
```

- [ ] **Step 2: Wire in `packages/agent/src/index.ts`**

After `const server = new AgentServer(...);`, add:

```ts
import { AuthHandler } from "./auth/handler.js";
import { CredentialWatcher } from "./auth/cred-watcher.js";

const authHandler = new AuthHandler({ send: (m) => server.send(m) });
server.setAuthRouter((m) => authHandler.handle(m));

const watcher = new CredentialWatcher({
  send: (m) => server.send(m),
  tools: [
    { tool: "claude-code", paths: ["/home/coder/.claude/.credentials.json"] },
    { tool: "codex",       paths: ["/home/coder/.codex/auth.json"] },
    { tool: "gh",          paths: ["/home/coder/.config/gh/hosts.yml"] },
  ],
});
watcher.start();
```

Extend the SIGTERM/SIGINT shutdown to call `watcher.stop()` before exit.

- [ ] **Step 3: Run agent typecheck**

Run: `pnpm --filter @agenthub/agent typecheck`
Expected: PASS.

- [ ] **Step 4: Run all agent tests**

Run: `pnpm --filter @agenthub/agent test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/
git commit -m "feat(agent-auth): wire AuthHandler + CredentialWatcher into daemon boot"
```

---

## Phase 3 — Server orchestrator + credential-sync

### Task 3.1: Orchestrator skeleton + state events

**Files:**
- Create: `packages/server/src/services/agent-auth/orchestrator.ts`
- Create: `packages/server/src/services/agent-auth/orchestrator.test.ts`

This task defines the orchestrator's `connect()` state machine against a **fake agent** (no real session spin-up — `SessionManager` is injected). Real-session wiring lands in Task 3.3.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/services/agent-auth/orchestrator.test.ts
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Orchestrator, type OrchestratorEvent, type AgentChannel } from "./orchestrator.js";

class FakeAgent extends EventEmitter implements AgentChannel {
  sent: unknown[] = [];
  send(msg: unknown): void { this.sent.push(msg); }
  on(ev: "message", cb: (msg: unknown) => void): this { super.on(ev, cb); return this; }
}

class FakeSessions {
  destroyed: string[] = [];
  async createAuthHelper(_userId: string): Promise<{ sessionId: string; agent: AgentChannel }> {
    const agent = new FakeAgent();
    return { sessionId: "sess-1", agent };
  }
  async destroy(sessionId: string): Promise<void> { this.destroyed.push(sessionId); }
}

class FakeStore {
  written = new Map<string, Record<string, string>>();
  async setSecrets(path: string, values: Record<string, string>): Promise<void> {
    this.written.set(path, { ...(this.written.get(path) ?? {}), ...values });
  }
  async getSecret(path: string, name: string): Promise<string | null> {
    return this.written.get(path)?.[name] ?? null;
  }
  async deletePath(_path: string): Promise<void> { /* no-op */ }
  async deleteSecret(_path: string, _name: string): Promise<void> {}
  async setSecret(_path: string, _name: string, _value: string): Promise<void> {}
  async getAllSecrets(_path: string): Promise<Record<string, string>> { return {}; }
  configured = true;
}

describe("Orchestrator.connect", () => {
  it("emits preparing → awaiting-url → captured → done and writes Infisical", async () => {
    const sessions = new FakeSessions();
    const store = new FakeStore();
    const orch = new Orchestrator({
      sessions: sessions as never,
      store: store as never,
      audit: async () => undefined,
    });

    const events: OrchestratorEvent[] = [];
    const run = orch.connect({ userId: "u1", toolId: "claude-code", onEvent: (e) => events.push(e) });

    // Simulate the agent emitting URL line and captured file.
    await new Promise((r) => setTimeout(r, 5));
    const agent = (sessions as unknown as { _last?: FakeAgent })._last!;
    agent.emit("message", { type: "auth.line", tool: "claude-code", stream: "stdout", line: "Visit https://claude.ai/oauth/authorize?x=1" });
    agent.emit("message", { type: "auth.captured", tool: "claude-code", path: "/home/coder/.claude/.credentials.json", contentsBase64: Buffer.from("{}").toString("base64") });
    agent.emit("message", { type: "auth.done", tool: "claude-code", ok: true });

    await run;

    expect(events.map((e) => e.phase)).toEqual(["preparing", "awaiting-url", "awaiting-callback", "captured", "done"]);
    expect(store.written.get("/users/u1/agents/claude-code")).toBeDefined();
    expect(sessions.destroyed).toEqual(["sess-1"]);
  });
});
```

Note: the test's `FakeSessions` returns an `AgentChannel`. For the test to work, also export the last-created agent — modify `FakeSessions` to store it:

```ts
class FakeSessions {
  _last?: FakeAgent;
  destroyed: string[] = [];
  async createAuthHelper(_userId: string): Promise<{ sessionId: string; agent: AgentChannel }> {
    const agent = new FakeAgent();
    this._last = agent;
    return { sessionId: "sess-1", agent };
  }
  async destroy(sessionId: string): Promise<void> { this.destroyed.push(sessionId); }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/agent-auth/orchestrator.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/server/src/services/agent-auth/orchestrator.ts
import { getTool } from "./registry.js";
import { agentCredentialPath, CREDENTIAL_SECRET_NAME } from "./paths.js";
import type { SecretStore } from "../secrets/index.js";
import type { AuditAction } from "./audit.js";

export type OrchestratorPhase =
  | "preparing"
  | "awaiting-url"
  | "awaiting-callback"
  | "captured"
  | "done"
  | "error";

export interface OrchestratorEvent {
  phase: OrchestratorPhase;
  url?: string;
  error?: string;
  expiresAt?: string;
}

export interface AgentChannel {
  send(msg: unknown): void;
  on(ev: "message", cb: (msg: unknown) => void): this;
}

export interface AuthHelperSession {
  sessionId: string;
  agent: AgentChannel;
}

export interface SessionsAPI {
  createAuthHelper(userId: string): Promise<AuthHelperSession>;
  destroy(sessionId: string): Promise<void>;
}

export interface OrchestratorDeps {
  sessions: SessionsAPI;
  store: SecretStore;
  audit: (entry: { userId: string; action: AuditAction; toolId: string; sessionId?: string; ok: boolean; error?: string }) => Promise<void>;
}

export interface ConnectArgs {
  userId: string;
  toolId: string;
  onEvent: (e: OrchestratorEvent) => void;
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async connect(args: ConnectArgs): Promise<void> {
    const tool = getTool(args.toolId);
    if (!tool) {
      args.onEvent({ phase: "error", error: `unknown tool: ${args.toolId}` });
      await this.deps.audit({ userId: args.userId, action: "connect", toolId: args.toolId, ok: false, error: "unknown tool" });
      return;
    }

    args.onEvent({ phase: "preparing" });
    const session = await this.deps.sessions.createAuthHelper(args.userId);

    let captured: { path: string; contentsBase64: string } | null = null;
    let urlEmitted = false;
    const urlRegex = tool.urlPattern;

    const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      session.agent.on("message", (raw) => {
        const msg = raw as { type: string } & Record<string, unknown>;
        if (msg.type === "auth.line") {
          const line = String(msg["line"] ?? "");
          if (!urlEmitted) {
            const m = line.match(urlRegex);
            if (m) {
              urlEmitted = true;
              args.onEvent({ phase: "awaiting-url", url: m[0] });
              args.onEvent({ phase: "awaiting-callback" });
            }
          }
        } else if (msg.type === "auth.captured") {
          captured = { path: String(msg["path"]), contentsBase64: String(msg["contentsBase64"]) };
          args.onEvent({ phase: "captured" });
        } else if (msg.type === "auth.done") {
          resolve({ ok: Boolean(msg["ok"]), error: msg["error"] as string | undefined });
        }
      });
    });

    session.agent.send({
      type: "auth.connect",
      tool: tool.id,
      loginCommand: tool.loginCommand,
      urlPattern: urlRegex.source,
      timeoutSec: tool.loginTimeoutSec,
    });

    const result = await done;

    try {
      if (result.ok && captured) {
        const path = agentCredentialPath(args.userId, tool.id);
        const contentsBuf = Buffer.from((captured as { contentsBase64: string }).contentsBase64, "base64");
        await this.deps.store.setSecrets(path, {
          [CREDENTIAL_SECRET_NAME]: contentsBuf.toString("utf8"),
          filePath: (captured as { path: string }).path,
        });
        const expiry = tool.expiryParser?.(contentsBuf.toString("utf8")) ?? null;
        args.onEvent({ phase: "done", expiresAt: expiry?.toISOString() });
        await this.deps.audit({ userId: args.userId, action: "connect", toolId: tool.id, sessionId: session.sessionId, ok: true });
        await this.deps.audit({ userId: args.userId, action: "capture", toolId: tool.id, sessionId: session.sessionId, ok: true });
      } else {
        args.onEvent({ phase: "error", error: result.error ?? "login failed" });
        await this.deps.audit({ userId: args.userId, action: "connect", toolId: tool.id, sessionId: session.sessionId, ok: false, error: result.error });
      }
    } finally {
      await this.deps.sessions.destroy(session.sessionId);
    }
  }
}
```

- [ ] **Step 4: Run to verify**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/agent-auth/orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/agent-auth/orchestrator.ts packages/server/src/services/agent-auth/orchestrator.test.ts
git commit -m "feat(agent-auth): connect orchestrator state machine"
```

---

### Task 3.2: Orchestrator disconnect + status

**Files:**
- Modify: `packages/server/src/services/agent-auth/orchestrator.ts`
- Modify: `packages/server/src/services/agent-auth/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
describe("Orchestrator.disconnect", () => {
  it("messages the daemon, deletes Infisical entry, audits", async () => {
    const sessions = new FakeSessions();
    const store = new FakeStore();
    await store.setSecrets("/users/u1/agents/claude-code", { credentials: "x" });
    const audits: unknown[] = [];
    const orch = new Orchestrator({
      sessions: sessions as never,
      store: store as never,
      audit: async (e) => { audits.push(e); },
    });

    const run = orch.disconnect({ userId: "u1", toolId: "claude-code" });
    await new Promise((r) => setTimeout(r, 5));
    const agent = (sessions as unknown as { _last?: FakeAgent })._last!;
    agent.emit("message", { type: "auth.disconnected", tool: "claude-code", ok: true });
    await run;

    expect(store.written.get("/users/u1/agents/claude-code")?.credentials).toBeUndefined();
    expect(audits).toHaveLength(1);
    expect((audits[0] as { action: string }).action).toBe("disconnect");
  });
});

describe("Orchestrator.status", () => {
  it("returns connected when credential exists in Infisical", async () => {
    const store = new FakeStore();
    await store.setSecrets("/users/u1/agents/claude-code", { credentials: "{}" });
    const orch = new Orchestrator({
      sessions: {} as never,
      store: store as never,
      audit: async () => undefined,
    });
    const s = await orch.status({ userId: "u1", toolId: "claude-code" });
    expect(s.status).toBe("connected");
  });

  it("returns disconnected when no credential present", async () => {
    const orch = new Orchestrator({
      sessions: {} as never,
      store: new FakeStore() as never,
      audit: async () => undefined,
    });
    const s = await orch.status({ userId: "u1", toolId: "codex" });
    expect(s.status).toBe("disconnected");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/agent-auth/orchestrator.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `Orchestrator`:

```ts
  async disconnect(args: { userId: string; toolId: string }): Promise<void> {
    const tool = getTool(args.toolId);
    if (!tool) return;
    const session = await this.deps.sessions.createAuthHelper(args.userId);
    try {
      const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
        session.agent.on("message", (raw) => {
          const m = raw as { type: string; ok?: boolean; error?: string };
          if (m.type === "auth.disconnected") resolve({ ok: Boolean(m.ok), error: m.error });
        });
      });
      session.agent.send({
        type: "auth.disconnect",
        tool: tool.id,
        logoutCommand: tool.logoutCommand,
        credentialPaths: tool.credentialPaths,
      });
      const result = await done;
      await this.deps.store.deletePath(agentCredentialPath(args.userId, tool.id)).catch(() => undefined);
      await this.deps.audit({ userId: args.userId, action: "disconnect", toolId: tool.id, sessionId: session.sessionId, ok: result.ok, error: result.error });
    } finally {
      await this.deps.sessions.destroy(session.sessionId);
    }
  }

  async status(args: { userId: string; toolId: string }): Promise<{ id: string; status: "connected" | "disconnected"; expiresAt?: string }> {
    const tool = getTool(args.toolId);
    if (!tool) return { id: args.toolId, status: "disconnected" };
    const cred = await this.deps.store.getSecret(agentCredentialPath(args.userId, tool.id), CREDENTIAL_SECRET_NAME);
    if (!cred) return { id: tool.id, status: "disconnected" };
    const expiry = tool.expiryParser?.(cred) ?? null;
    return { id: tool.id, status: "connected", expiresAt: expiry?.toISOString() };
  }
```

- [ ] **Step 4: Run to verify**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/agent-auth/orchestrator.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/agent-auth/
git commit -m "feat(agent-auth): orchestrator disconnect + status"
```

---

### Task 3.3: SessionManager — `createAuthHelperSession()`

**Files:**
- Modify: `packages/server/src/services/session-manager.ts`
- Modify: `packages/server/src/db/schema.ts` (add `purpose` column)
- Modify: `packages/server/src/db/index.ts` (add `purpose` to sessions table)

The auth-helper session needs a marker so it doesn't show up in the user-facing Sessions list. Add a `purpose` column to `sessions` (`text`, default `"user"`).

- [ ] **Step 1: Add the column**

`db/schema.ts` — add to `sessions`:

```ts
  purpose: text("purpose").notNull().default("user"),
```

`db/index.ts` — append to the `CREATE TABLE IF NOT EXISTS sessions` body before the closing paren? No — that table already exists in prod. Use the existing `addColumnIfMissing` pattern at the bottom of `initDb`:

```ts
  addColumnIfMissing("sessions", "purpose", "TEXT NOT NULL DEFAULT 'user'");
```

- [ ] **Step 2: Add the helper to SessionManager**

In `packages/server/src/services/session-manager.ts`, add a public method. The simplest approach: call the existing `create()` with a flag, and have the session manager skip ttyd/MCP setup when `purpose !== "user"`.

```ts
  async createAuthHelper(userId: string): Promise<{ sessionId: string; agent: AgentChannel }> {
    const session = await this.create({
      userId,
      name: `auth-helper-${Date.now()}`,
      purpose: "agent-auth",
    });
    const ready = await this.waitForAgentReady(session.id, { timeoutMs: 60_000 });
    if (!ready) throw new Error("auth helper failed to reach ready");
    const agentEntry = this.agents.get(session.id);
    if (!agentEntry) throw new Error("auth helper has no agent connection");
    return {
      sessionId: session.id,
      agent: {
        send: (m) => agentEntry.ws.send(JSON.stringify(m)),
        on: (_ev, cb) => {
          agentEntry.ws.on("message", (raw) => {
            try { cb(JSON.parse(raw.toString())); } catch { /* ignore */ }
          });
          return undefined as never;
        },
      },
    };
  }
```

`waitForAgentReady` is a helper to add if not already present. Implement adjacent to `setupAgentListeners`:

```ts
  private async waitForAgentReady(
    sessionId: string,
    opts: { timeoutMs: number },
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < opts.timeoutMs) {
      const entry = this.agents.get(sessionId);
      if (entry && entry.ws.readyState === entry.ws.OPEN) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }
```

In `create()`, plumb through `purpose` and pass it to the DB insert. Sessions with `purpose !== "user"` skip ttyd allocation in `setupAgentListeners` (so we don't burn a terminal port for a flow that doesn't need one).

In the existing list-sessions query, add `WHERE purpose = 'user'` so auth helpers don't appear in the UI.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @agenthub/server typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/db/ packages/server/src/services/session-manager.ts
git commit -m "feat(session): add session.purpose column + createAuthHelper helper"
```

---

### Task 3.4: credential-sync — hydrate on session start

**Files:**
- Create: `packages/server/src/services/agent-auth/credential-sync.ts`
- Create: `packages/server/src/services/agent-auth/credential-sync.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/services/agent-auth/credential-sync.test.ts
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { hydrateSession, type HydrateDeps } from "./credential-sync.js";
import type { AgentChannel } from "./orchestrator.js";

class FakeAgent extends EventEmitter implements AgentChannel {
  sent: unknown[] = [];
  send(m: unknown): void { this.sent.push(m); }
  on(ev: "message", cb: (m: unknown) => void): this { super.on(ev, cb); return this; }
}

describe("hydrateSession", () => {
  it("requests missing paths from store and pushes to daemon", async () => {
    const agent = new FakeAgent();
    const deps: HydrateDeps = {
      getStored: async (_userId, toolId) => {
        if (toolId === "claude-code") return { contents: "{\"x\":1}", filePath: "/home/coder/.claude/.credentials.json" };
        return null;
      },
    };
    const run = hydrateSession({ userId: "u1", agent, deps });
    // Wait for hydrateProbe to be sent.
    await new Promise((r) => setTimeout(r, 5));
    expect(agent.sent[0]).toMatchObject({ type: "auth.hydrateProbe" });
    // Reply: claude-code's path is missing, codex/gh present.
    agent.emit("message", { type: "auth.hydrateProbeResult", missing: [{ tool: "claude-code", path: "/home/coder/.claude/.credentials.json" }] });
    await run;
    const hydrateMsg = agent.sent.find((m) => (m as { type: string }).type === "auth.hydrate") as { entries: Array<{ tool: string }> };
    expect(hydrateMsg.entries).toHaveLength(1);
    expect(hydrateMsg.entries[0].tool).toBe("claude-code");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/agent-auth/credential-sync.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/server/src/services/agent-auth/credential-sync.ts
import { AGENT_TOOLS } from "./registry.js";
import type { AgentChannel } from "./orchestrator.js";

export interface StoredCredential { contents: string; filePath: string }
export interface HydrateDeps {
  getStored(userId: string, toolId: string): Promise<StoredCredential | null>;
}

export async function hydrateSession(args: {
  userId: string;
  agent: AgentChannel;
  deps: HydrateDeps;
}): Promise<void> {
  const tools = AGENT_TOOLS.map((t) => ({ tool: t.id, paths: t.credentialPaths }));
  const probe = new Promise<Array<{ tool: string; path: string }>>((resolve) => {
    args.agent.on("message", (raw) => {
      const m = raw as { type: string; missing?: unknown };
      if (m.type === "auth.hydrateProbeResult") {
        resolve((m.missing as Array<{ tool: string; path: string }>) ?? []);
      }
    });
  });
  args.agent.send({ type: "auth.hydrateProbe", tools });
  const missing = await probe;
  if (missing.length === 0) return;

  const entries: Array<{ tool: string; path: string; contentsBase64: string }> = [];
  for (const m of missing) {
    const stored = await args.deps.getStored(args.userId, m.tool);
    if (!stored) continue;
    entries.push({ tool: m.tool, path: m.path, contentsBase64: Buffer.from(stored.contents).toString("base64") });
  }
  if (entries.length === 0) return;
  args.agent.send({ type: "auth.hydrate", entries });
}
```

- [ ] **Step 4: Run to verify**

Run: `pnpm --filter @agenthub/server exec vitest run src/services/agent-auth/credential-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/agent-auth/credential-sync.ts packages/server/src/services/agent-auth/credential-sync.test.ts
git commit -m "feat(agent-auth): hydrateSession — probe daemon, push missing credentials"
```

---

### Task 3.5: Wire hydration into SessionManager post-active

**Files:**
- Modify: `packages/server/src/services/session-manager.ts`

- [ ] **Step 1: Find the spot where sessions transition to `active`**

Locate the `setStatus(sessionId, "active", ...)` call in `session-manager.ts`. Immediately after, for sessions where `purpose === "user"`, call `hydrateSession()`.

- [ ] **Step 2: Add the call**

```ts
import { hydrateSession } from "./agent-auth/credential-sync.js";
import { agentCredentialPath, CREDENTIAL_SECRET_NAME } from "./agent-auth/paths.js";
import { getSecretStore } from "./secrets/index.js";

// ...inside the post-active block:
if (session.purpose === "user" && session.userId) {
  const agentEntry = this.agents.get(session.id);
  if (agentEntry) {
    const store = getSecretStore();
    if (store.configured) {
      const channel = {
        send: (m: unknown) => agentEntry.ws.send(JSON.stringify(m)),
        on: (_ev: "message", cb: (m: unknown) => void) => {
          agentEntry.ws.on("message", (raw) => {
            try { cb(JSON.parse(raw.toString())); } catch { /* ignore */ }
          });
          return undefined as never;
        },
      };
      void hydrateSession({
        userId: session.userId,
        agent: channel as never,
        deps: {
          getStored: async (uid, toolId) => {
            const path = agentCredentialPath(uid, toolId);
            const contents = await store.getSecret(path, CREDENTIAL_SECRET_NAME);
            const filePath = await store.getSecret(path, "filePath");
            if (!contents || !filePath) return null;
            return { contents, filePath };
          },
        },
      }).catch((err) => {
        console.warn(`[session ${session.id}] hydrate failed: ${(err as Error).message}`);
      });
    }
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @agenthub/server typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/services/session-manager.ts
git commit -m "feat(agent-auth): hydrate credentials when a user session goes active"
```

---

## Phase 4 — HTTP routes

### Task 4.1: GET /api/integrations/agents

**Files:**
- Create: `packages/server/src/routes/integrations-agents.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Implement (route is small; integration-test it in Task 4.4)**

```ts
// packages/server/src/routes/integrations-agents.ts
import { Hono } from "hono";
import { db } from "../db/index.js";
import { Orchestrator } from "../services/agent-auth/orchestrator.js";
import { AGENT_TOOLS } from "../services/agent-auth/registry.js";
import { writeAudit } from "../services/agent-auth/audit.js";
import { getSecretStore } from "../services/secrets/index.js";
import type { SessionManager } from "../services/session-manager.js";
import { requireUser } from "../middleware/auth.js";

export function integrationsAgentsRoutes(sessions: SessionManager) {
  const app = new Hono();
  const store = getSecretStore();
  const orch = new Orchestrator({
    sessions: {
      createAuthHelper: (uid) => sessions.createAuthHelper(uid),
      destroy: (sid) => sessions.destroy(sid),
    },
    store,
    audit: (entry) => writeAudit(db, entry),
  });

  app.use("*", requireUser);

  app.get("/", async (c) => {
    const user = c.get("user");
    const results = await Promise.all(
      AGENT_TOOLS.map(async (t) => {
        const s = await orch.status({ userId: user.id, toolId: t.id });
        return { id: t.id, displayName: t.displayName, status: s.status, expiresAt: s.expiresAt };
      }),
    );
    return c.json({ tools: results });
  });

  return app;
}
```

Confirm the existing auth-middleware import path matches reality; if `requireUser` is exported from a different module, adjust.

- [ ] **Step 2: Mount in `index.ts`**

Add the import and:

```ts
app.route("/api/integrations/agents", integrationsAgentsRoutes(sessionManager));
```

- [ ] **Step 3: Smoke test**

Run: `pnpm --filter @agenthub/server dev` in one shell. In another:

```bash
curl -b cookies.txt http://localhost:3000/api/integrations/agents
```

Expected: `{"tools":[{"id":"claude-code","status":"disconnected",...}, ...]}` for a logged-in user.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes/integrations-agents.ts packages/server/src/index.ts
git commit -m "feat(agent-auth): GET /api/integrations/agents returns per-user tool status"
```

---

### Task 4.2: POST /api/integrations/agents/:toolId/connect (SSE)

**Files:**
- Modify: `packages/server/src/routes/integrations-agents.ts`

- [ ] **Step 1: Add the SSE handler**

```ts
import { streamSSE } from "hono/streaming";

app.post("/:toolId/connect", async (c) => {
  const user = c.get("user");
  const toolId = c.req.param("toolId");
  return streamSSE(c, async (stream) => {
    await orch.connect({
      userId: user.id,
      toolId,
      onEvent: async (e) => {
        if (e.phase === "awaiting-url" && e.url) {
          await stream.writeSSE({ event: "url", data: JSON.stringify({ url: e.url }) });
        } else if (e.phase === "captured") {
          await stream.writeSSE({ event: "captured", data: "{}" });
        } else if (e.phase === "done") {
          await stream.writeSSE({ event: "done", data: JSON.stringify({ ok: true, expiresAt: e.expiresAt }) });
        } else if (e.phase === "error") {
          await stream.writeSSE({ event: "error", data: JSON.stringify({ message: e.error ?? "unknown" }) });
        } else {
          await stream.writeSSE({ event: "state", data: JSON.stringify({ phase: e.phase }) });
        }
      },
    }).catch((err) => stream.writeSSE({ event: "error", data: JSON.stringify({ message: (err as Error).message }) }));
  });
});
```

- [ ] **Step 2: Manual smoke**

Run dev server, then `curl -N -X POST -b cookies.txt http://localhost:3000/api/integrations/agents/claude-code/connect`. Expect SSE events (this only fully works after Phase 6, but the route should at least start streaming and emit `preparing`).

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/routes/integrations-agents.ts
git commit -m "feat(agent-auth): POST /:toolId/connect SSE-stream connect flow"
```

---

### Task 4.3: POST disconnect + refresh

**Files:**
- Modify: `packages/server/src/routes/integrations-agents.ts`

- [ ] **Step 1: Add handlers**

```ts
app.post("/:toolId/disconnect", async (c) => {
  const user = c.get("user");
  const toolId = c.req.param("toolId");
  await orch.disconnect({ userId: user.id, toolId });
  return c.json({ ok: true });
});

app.post("/:toolId/refresh", async (c) => {
  // Functionally identical to connect — same orchestrator method. The web UI
  // labels the button differently for tools that are already connected.
  const user = c.get("user");
  const toolId = c.req.param("toolId");
  return streamSSE(c, async (stream) => {
    await orch.connect({
      userId: user.id,
      toolId,
      onEvent: async (e) => {
        await stream.writeSSE({ event: "state", data: JSON.stringify(e) });
      },
    });
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/routes/integrations-agents.ts
git commit -m "feat(agent-auth): disconnect and refresh endpoints"
```

---

### Task 4.4: Integration test — full route roundtrip with fake daemon

**Files:**
- Create: `packages/server/src/routes/integrations-agents.test.ts`

- [ ] **Step 1: Write the test**

```ts
// packages/server/src/routes/integrations-agents.test.ts
import { describe, expect, it } from "vitest";
import { integrationsAgentsRoutes } from "./integrations-agents.js";

// Stub SessionManager + SecretStore. Validates wiring + status response shape.
describe("integrations-agents routes", () => {
  it("GET / returns disconnected status for all tools by default", async () => {
    const sessions = { createAuthHelper: async () => { throw new Error("not used"); }, destroy: async () => {} };
    const app = integrationsAgentsRoutes(sessions as never);
    const res = await app.request("/", {
      headers: { cookie: "session=test" },
    });
    // Without auth middleware bypass, this will 401 — adjust based on
    // however other route tests inject a user. Pattern follows
    // packages/server/src/routes/auth.test.ts.
    expect([200, 401]).toContain(res.status);
  });
});
```

Adapt this test to whatever pattern `packages/server/src/routes/auth.test.ts` (which already exists) uses for injecting authentication. The point of this task is to lock in that the route is mounted and returns the right JSON shape — the orchestrator itself is already tested in Phase 3.

- [ ] **Step 2: Run + commit**

```bash
pnpm --filter @agenthub/server exec vitest run src/routes/integrations-agents.test.ts
git add packages/server/src/routes/integrations-agents.test.ts
git commit -m "test(agent-auth): integration smoke test for routes"
```

---

## Phase 5 — Web UI

### Task 5.1: `useAgentStatus` hook

**Files:**
- Create: `packages/web/src/components/agent-auth/useAgentStatus.ts`

- [ ] **Step 1: Implement**

```tsx
// packages/web/src/components/agent-auth/useAgentStatus.ts
import { useEffect, useState, useCallback } from "react";

export interface AgentStatus {
  id: string;
  displayName: string;
  status: "connected" | "disconnected";
  expiresAt?: string;
}

export function useAgentStatus(): { tools: AgentStatus[]; refresh: () => Promise<void> } {
  const [tools, setTools] = useState<AgentStatus[]>([]);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/integrations/agents", { credentials: "include" });
    if (!r.ok) return;
    const j = await r.json() as { tools: AgentStatus[] };
    setTools(j.tools);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return { tools, refresh };
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm --filter @agenthub/web typecheck
git add packages/web/src/components/agent-auth/useAgentStatus.ts
git commit -m "feat(agent-auth/ui): useAgentStatus hook"
```

---

### Task 5.2: `AgentCard` component

**Files:**
- Create: `packages/web/src/components/agent-auth/AgentCard.tsx`

- [ ] **Step 1: Implement**

```tsx
// packages/web/src/components/agent-auth/AgentCard.tsx
import type { AgentStatus } from "./useAgentStatus.js";

interface Props {
  tool: AgentStatus;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function AgentCard({ tool, onConnect, onDisconnect }: Props) {
  const connected = tool.status === "connected";
  return (
    <div className="agent-card">
      <div className="agent-card__head">
        <span className={`dot ${connected ? "dot--ok" : "dot--idle"}`} />
        <strong>{tool.displayName}</strong>
      </div>
      <div className="agent-card__body">
        {connected ? (
          <>
            <span>Connected</span>
            {tool.expiresAt && <span className="muted"> · expires {new Date(tool.expiresAt).toLocaleDateString()}</span>}
          </>
        ) : (
          <span className="muted">Not connected</span>
        )}
      </div>
      <div className="agent-card__actions">
        {connected ? (
          <>
            <button onClick={onConnect}>Refresh</button>
            <button onClick={onDisconnect}>Disconnect</button>
          </>
        ) : (
          <button onClick={onConnect}>Connect</button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/components/agent-auth/AgentCard.tsx
git commit -m "feat(agent-auth/ui): AgentCard component"
```

---

### Task 5.3: `AgentLoginModal` — SSE consumer + URL button

**Files:**
- Create: `packages/web/src/components/agent-auth/AgentLoginModal.tsx`

- [ ] **Step 1: Implement**

```tsx
// packages/web/src/components/agent-auth/AgentLoginModal.tsx
import { useEffect, useState } from "react";

interface Props {
  toolId: string;
  displayName: string;
  onClose: (success: boolean) => void;
}

type Phase = "preparing" | "awaiting-url" | "awaiting-callback" | "captured" | "done" | "error";

export function AgentLoginModal({ toolId, displayName, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("preparing");
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    void runConnect(toolId, ctrl.signal, {
      setPhase, setUrl, setError, onDone: (ok) => { if (ok) setTimeout(() => onClose(true), 1500); },
    });
    return () => ctrl.abort();
  }, [toolId, onClose]);

  return (
    <div className="modal-backdrop" onClick={() => onClose(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Connect {displayName}</h2>
        {phase === "preparing" && <p>Preparing secure auth helper…</p>}
        {phase === "awaiting-url" && url && (
          <>
            <a className="big-button" href={url} target="_blank" rel="noreferrer">Open {displayName} login →</a>
            <p className="muted">Sign in with the account you want this workspace to use.</p>
          </>
        )}
        {phase === "awaiting-callback" && <p>Waiting for you to complete the sign-in…</p>}
        {phase === "captured" && <p>Credentials captured. Finalising…</p>}
        {phase === "done" && <p className="ok">✓ Connected.</p>}
        {phase === "error" && <p className="err">{error ?? "Something went wrong."}</p>}
        <button onClick={() => onClose(false)}>{phase === "done" ? "Close" : "Cancel"}</button>
      </div>
    </div>
  );
}

async function runConnect(
  toolId: string,
  signal: AbortSignal,
  cbs: {
    setPhase: (p: Phase) => void;
    setUrl: (u: string | null) => void;
    setError: (m: string) => void;
    onDone: (ok: boolean) => void;
  },
): Promise<void> {
  const r = await fetch(`/api/integrations/agents/${toolId}/connect`, {
    method: "POST",
    credentials: "include",
    signal,
  });
  if (!r.body) { cbs.setError("no stream"); cbs.setPhase("error"); return; }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleEvent(chunk, cbs);
    }
  }
}

function handleEvent(
  chunk: string,
  cbs: { setPhase: (p: Phase) => void; setUrl: (u: string | null) => void; setError: (m: string) => void; onDone: (ok: boolean) => void },
): void {
  let event = "message";
  let data = "";
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data += line.slice(6);
  }
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(data) as Record<string, unknown>; } catch { /* fine */ }
  if (event === "url") { cbs.setUrl(String(parsed["url"])); cbs.setPhase("awaiting-url"); }
  else if (event === "captured") cbs.setPhase("captured");
  else if (event === "done") { cbs.setPhase("done"); cbs.onDone(true); }
  else if (event === "error") { cbs.setError(String(parsed["message"] ?? "")); cbs.setPhase("error"); cbs.onDone(false); }
  else if (event === "state" && typeof parsed["phase"] === "string") {
    cbs.setPhase(parsed["phase"] as Phase);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/components/agent-auth/AgentLoginModal.tsx
git commit -m "feat(agent-auth/ui): AgentLoginModal SSE consumer with URL button"
```

---

### Task 5.4: Wire Agent CLIs section into Integrations page

**Files:**
- Modify: `packages/web/src/pages/Integrations.tsx`

- [ ] **Step 1: Add the new section above existing AI providers**

Locate the JSX where the existing AI provider cards render. Above that block, add:

```tsx
import { useAgentStatus } from "../components/agent-auth/useAgentStatus.js";
import { AgentCard } from "../components/agent-auth/AgentCard.js";
import { AgentLoginModal } from "../components/agent-auth/AgentLoginModal.js";

// ...inside the component:
const { tools, refresh } = useAgentStatus();
const [modalTool, setModalTool] = useState<{ id: string; displayName: string } | null>(null);

const onDisconnect = async (id: string) => {
  await fetch(`/api/integrations/agents/${id}/disconnect`, { method: "POST", credentials: "include" });
  await refresh();
};

// ...in JSX:
<section>
  <h2>Agent CLIs</h2>
  <p className="muted">One-click sign-in for the coding-agent CLIs available in every workspace.</p>
  <div className="agent-grid">
    {tools.map((t) => (
      <AgentCard
        key={t.id}
        tool={t}
        onConnect={() => setModalTool({ id: t.id, displayName: t.displayName })}
        onDisconnect={() => onDisconnect(t.id)}
      />
    ))}
  </div>
</section>

{modalTool && (
  <AgentLoginModal
    toolId={modalTool.id}
    displayName={modalTool.displayName}
    onClose={(success) => { setModalTool(null); if (success) void refresh(); }}
  />
)}
```

- [ ] **Step 2: Add minimal CSS**

Append to whichever stylesheet drives Integrations (search for `agent-card` selectors first; if none exist, add to `packages/web/src/styles.css` or equivalent — match the project's CSS pattern):

```css
.agent-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
.agent-card { border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
.agent-card__head { display: flex; gap: 8px; align-items: center; }
.dot { width: 8px; height: 8px; border-radius: 50%; }
.dot--ok { background: var(--ok, #2ea043); }
.dot--idle { background: var(--muted, #888); }
.agent-card__actions { display: flex; gap: 8px; margin-top: 10px; }
.big-button { display: block; padding: 14px 18px; background: var(--accent); color: white; text-decoration: none; border-radius: 6px; text-align: center; margin: 12px 0; font-weight: 600; }
```

- [ ] **Step 3: Visually verify**

```bash
pnpm dev
```

Open `http://localhost:5173/integrations`, confirm:
- "Agent CLIs" section appears above existing AI provider cards.
- Three cards render: Claude Code, OpenAI Codex, GitHub CLI — all showing "Not connected."
- Clicking "Connect" on Claude Code opens the modal and the SSE stream starts (you'll see "Preparing secure auth helper…" — the flow won't complete without a real session backend, but the UI plumbing is verified).

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/pages/Integrations.tsx packages/web/src/styles.css
git commit -m "feat(agent-auth/ui): wire Agent CLIs section into Integrations page"
```

---

## Phase 6 — Admin: audit log

### Task 6.1: GET /api/admin/agent-auth/audit + registry view

**Files:**
- Create: `packages/server/src/routes/admin-agent-auth.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Implement**

```ts
// packages/server/src/routes/admin-agent-auth.ts
import { Hono } from "hono";
import { db } from "../db/index.js";
import { listAudit } from "../services/agent-auth/audit.js";
import { AGENT_TOOLS } from "../services/agent-auth/registry.js";
import { requireAdmin } from "../middleware/auth.js";

export function adminAgentAuthRoutes() {
  const app = new Hono();
  app.use("*", requireAdmin);

  app.get("/audit", async (c) => {
    const userId = c.req.query("userId");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10), 500);
    if (!userId) return c.json({ error: "userId required" }, 400);
    const rows = await listAudit(db, { userId, limit });
    return c.json({ rows });
  });

  app.get("/registry", (c) => {
    return c.json({
      tools: AGENT_TOOLS.map((t) => ({
        id: t.id,
        displayName: t.displayName,
        loginCommand: t.loginCommand,
        credentialPaths: t.credentialPaths,
      })),
    });
  });

  return app;
}
```

Match the existing admin-middleware import (`requireAdmin` may live elsewhere — check `packages/server/src/middleware/`).

- [ ] **Step 2: Mount**

In `packages/server/src/index.ts`:

```ts
app.route("/api/admin/agent-auth", adminAgentAuthRoutes());
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/routes/admin-agent-auth.ts packages/server/src/index.ts
git commit -m "feat(agent-auth): admin audit + registry endpoints"
```

---

### Task 6.2: Admin audit page

**Files:**
- Create: `packages/web/src/pages/admin/AgentAuthAudit.tsx`
- Modify: whichever admin router file mounts existing admin pages

- [ ] **Step 1: Implement (read-only table)**

```tsx
// packages/web/src/pages/admin/AgentAuthAudit.tsx
import { useEffect, useState } from "react";

interface AuditRow {
  id: number; ts: number; userId: string; action: string; toolId: string; sessionId?: string; ok: boolean; error?: string;
}

export function AgentAuthAudit() {
  const [userId, setUserId] = useState("");
  const [rows, setRows] = useState<AuditRow[]>([]);

  const fetchAudit = async () => {
    if (!userId) return;
    const r = await fetch(`/api/admin/agent-auth/audit?userId=${encodeURIComponent(userId)}&limit=200`, { credentials: "include" });
    if (r.ok) { const j = await r.json() as { rows: AuditRow[] }; setRows(j.rows); }
  };

  useEffect(() => { void fetchAudit(); }, [userId]);

  return (
    <div>
      <h1>Agent CLI Auth — Audit Log</h1>
      <label>User ID <input value={userId} onChange={(e) => setUserId(e.target.value)} /></label>
      <table>
        <thead><tr><th>Time</th><th>Action</th><th>Tool</th><th>Session</th><th>OK</th><th>Error</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.ts).toISOString()}</td>
              <td>{r.action}</td>
              <td>{r.toolId}</td>
              <td>{r.sessionId ?? ""}</td>
              <td>{r.ok ? "✓" : "✗"}</td>
              <td>{r.error ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Mount the route**

Find the existing admin router (e.g. `packages/web/src/pages/Admin.tsx` or a parent route map) and add the new page. Mirror how other admin pages (e.g. `packages/web/src/pages/admin/InstallBackup.tsx`) are registered.

- [ ] **Step 3: Visual verify**

`pnpm dev`, log in as admin, navigate to the audit page, enter your own user ID, confirm an empty table renders.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/pages/admin/AgentAuthAudit.tsx
git commit -m "feat(agent-auth): admin audit-log page"
```

---

## Phase 7 — E2E test + manual verification doc + cleanup

### Task 7.1: Server integration test with fake CLI

**Files:**
- Create: `packages/server/test/fixtures/fake-cli/fake-claude.sh`
- Create: `packages/server/src/services/agent-auth/integration.test.ts`

- [ ] **Step 1: Create the fake CLI**

```bash
# packages/server/test/fixtures/fake-cli/fake-claude.sh
#!/bin/sh
set -eu
echo "Open this URL in your browser:"
echo "https://claude.ai/oauth/authorize?fake=1&state=test"
sleep 0.2
mkdir -p "$HOME/.claude"
echo '{"token":"fake-token","expiresAt":'"$(($(date +%s) * 1000 + 86400000))"'}' > "$HOME/.claude/.credentials.json"
```

`chmod +x packages/server/test/fixtures/fake-cli/fake-claude.sh`.

- [ ] **Step 2: Write the integration test**

This test exercises the daemon-side handler + watcher together against the fake CLI: the handler spawns the script, the script writes the credential file, the watcher catches it and emits `auth.captured`. This validates the daemon half of the flow end-to-end without needing a real workspace container. The server-side orchestrator is already covered by `orchestrator.test.ts` with a FakeAgent.

```ts
// packages/agent/src/auth/integration.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AuthHandler } from "./handler.js";
import { CredentialWatcher } from "./cred-watcher.js";
import type { AuthOutbound } from "./protocol.js";

describe("daemon auth integration", () => {
  it("running fake-claude.sh produces an auth.captured event via the watcher", async () => {
    const home = mkdtempSync(join(tmpdir(), "fakehome-"));
    const credPath = join(home, ".claude", ".credentials.json");
    const fakeCli = resolve(
      __dirname,
      "../../../server/test/fixtures/fake-cli/fake-claude.sh",
    );

    const events: AuthOutbound[] = [];
    const send = (m: AuthOutbound): void => { events.push(m); };

    const handler = new AuthHandler({ send });
    const watcher = new CredentialWatcher({
      send,
      debounceMs: 30,
      tools: [{ tool: "claude-code", paths: [credPath] }],
    });
    watcher.start();

    await handler.handle({
      type: "auth.connect",
      tool: "claude-code",
      loginCommand: `HOME=${home} sh ${fakeCli}`,
      urlPattern: "https://claude\\.ai/oauth/[^\\s]+",
      timeoutSec: 5,
    });

    // Watcher fires on a 30ms debounce after the file write inside the script.
    await new Promise((r) => setTimeout(r, 200));
    watcher.stop();

    const captured = events.find((e) => e.type === "auth.captured");
    expect(captured).toBeDefined();
    expect((captured as { tool: string }).tool).toBe("claude-code");

    const lines = events.filter((e) => e.type === "auth.line");
    expect(lines.some((l) => (l as { line: string }).line.includes("claude.ai/oauth"))).toBe(true);

    const done = events.find((e) => e.type === "auth.done") as { ok: boolean };
    expect(done.ok).toBe(true);
  });
});
```

Note the test lives in `packages/agent/`, not `packages/server/`, because both daemon components under test are agent-package files. The fake CLI script lives in `packages/server/test/fixtures/` because the e2e harness expects to find fixtures there.

- [ ] **Step 3: Run**

Run: `pnpm --filter @agenthub/agent exec vitest run src/auth/integration.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/test/fixtures/ packages/agent/src/auth/integration.test.ts
git commit -m "test(agent-auth): daemon handler+watcher roundtrip via fake-claude fixture"
```

---

### Task 7.2: Extend `scripts/e2e-full.js`

**Files:**
- Modify: `scripts/e2e-full.js`

- [ ] **Step 1: Add an agent-auth smoke section**

Skipping the OAuth round-trip (which requires real Anthropic/OpenAI), validate just:

1. `GET /api/integrations/agents` returns all three tools with `disconnected` status.
2. `GET /api/admin/agent-auth/registry` returns the registry.

```js
// inside e2e-full.js, in the test sequence:
log("--- agent-auth smoke ---");
const agentsRes = await fetch(`${BASE}/api/integrations/agents`, { headers: { cookie } });
assert(agentsRes.ok, "GET /api/integrations/agents");
const agentsBody = await agentsRes.json();
assert(Array.isArray(agentsBody.tools) && agentsBody.tools.length >= 3, "three tools registered");
log(`agent-auth: ${agentsBody.tools.map(t => `${t.id}=${t.status}`).join(", ")}`);
```

- [ ] **Step 2: Commit**

```bash
git add scripts/e2e-full.js
git commit -m "test(agent-auth): e2e-full smoke for /api/integrations/agents"
```

---

### Task 7.3: Manual verification doc

**Files:**
- Create: `docs/operations/agent-auth-verification.md`

- [ ] **Step 1: Write**

```markdown
# Agent CLI Auth — Manual verification

Live OAuth flows require real Anthropic/OpenAI/GitHub accounts; this checklist runs on a fresh VM with the install completed and you logged in as a regular user.

## Claude Code

1. Go to **Integrations → Agent CLIs**. Confirm "Claude Code" shows "Not connected".
2. Click **Connect**. Modal shows "Preparing secure auth helper…".
3. After ~5-15s, a big "Open Claude login →" button appears. Click it.
4. Sign in with the Anthropic account you want this workspace to use.
5. Return to the AgentHub tab. Modal flips to "✓ Connected" and closes.
6. Open a new session, terminal in, run `claude --version` and then a quick prompt — confirm it works without re-auth.
7. Click **Disconnect** on the card. Confirm `~/.claude/.credentials.json` is gone from the workspace.
8. Optional: clear the per-user volume (`docker volume rm agenthub-home-<userId>`), open a new session, confirm credentials hydrate from Infisical.

## Codex

Repeat the same flow with the OpenAI Codex card. The OAuth tab goes to `auth.openai.com`.

## GitHub CLI

Repeat with the GitHub CLI card. The OAuth flow uses GitHub's device-code page.

## Audit log

As admin, open **Admin → Agent CLI Audit**, paste your user ID, confirm the `connect` and `capture` rows appear.
```

- [ ] **Step 2: Commit**

```bash
git add docs/operations/agent-auth-verification.md
git commit -m "docs(agent-auth): manual verification checklist"
```

---

### Task 7.4: Flag and remove the vestigial `claude_credentials` column

The pre-existing `user_credentials.claude_credentials` column is never read or written (verified during planning). Per global policy ("Replace, don't deprecate"), remove it.

**Files:**
- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/db/index.ts`

- [ ] **Step 1: Remove from schema and init**

In `schema.ts`, remove the `claudeCredentials` field from `userCredentials`.

In `db/index.ts`, the `CREATE TABLE IF NOT EXISTS user_credentials` block already exists for legacy DBs; leave the column declaration (SQLite can't drop a column without rebuild), but stop referencing it in code. Add an idempotent guard comment:

```ts
// Note: user_credentials.claude_credentials is vestigial — replaced by
// per-user Infisical storage under /users/{userId}/agents/claude-code/.
// The column stays in the DB for legacy installs but is unused.
```

- [ ] **Step 2: grep + typecheck**

Run: `grep -rn "claude_credentials\|claudeCredentials" packages/server/src` → expect only the comment above.
Run: `pnpm --filter @agenthub/server typecheck` → PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/db/
git commit -m "chore(agent-auth): drop vestigial userCredentials.claudeCredentials field"
```

---

## Phase 8 — Pre-merge verification

### Task 8.1: Full project verify

- [ ] **Step 1: Typecheck across the monorepo**

Run: `pnpm typecheck`
Expected: PASS, no warnings.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: PASS, no warnings.

- [ ] **Step 3: Unit tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 4: Dev server smoke test**

Run: `pnpm dev`

Open http://localhost:5173/integrations:
- Confirm "Agent CLIs" section renders with three disconnected cards.
- Open browser DevTools → Network. Click Connect on Claude Code. Confirm the SSE stream opens and emits at least the `state: preparing` event.

- [ ] **Step 5: E2E** (on a fresh VM that's already passing e2e-full)

```bash
docker cp scripts/e2e-full.js agenthub-agenthub-server-1:/tmp/e2e.js
docker exec -e ADMIN_PASSWORD=<pw> agenthub-agenthub-server-1 node /tmp/e2e.js
```

Expected: previous E2E sections still pass; new `--- agent-auth smoke ---` section passes.

- [ ] **Step 6: Manual verification on VM**

Walk through `docs/operations/agent-auth-verification.md` end-to-end with a real Claude Pro / ChatGPT / GitHub account. Capture screenshots for the PR.

- [ ] **Step 7: Open PR**

```bash
gh pr create --title "feat: agent-cli auth integration (Claude / Codex / GitHub)" --body "$(cat <<'EOF'
## Summary
- Adds "Agent CLIs" section to Integrations: one-click Connect/Disconnect for Claude Code, OpenAI Codex, GitHub CLI.
- Server-side orchestrator spawns ephemeral auth-helper sessions, runs each CLI's own `/login` command, streams output to the UI, captures the resulting credential file, and mirrors it to Infisical for cross-volume durability.
- Per-user `agenthub-home-${userId}` volume keeps credentials hot for every session; hydration on session-active restores from Infisical when the volume is fresh.
- New `agent_auth_audit` table records every connect/disconnect/capture.

## Test plan
- [x] `pnpm typecheck`
- [x] `pnpm lint`
- [x] `pnpm test`
- [x] `scripts/e2e-full.js` passes (incl. new agent-auth smoke section)
- [x] Manual flow on fresh VM per `docs/operations/agent-auth-verification.md` for all three tools
- [x] Verified hydration after volume wipe

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Plan self-review notes

Worked through every section of the spec; mapped each requirement to a task:

| Spec section | Task(s) |
|---|---|
| Tool registry | 1.1, 1.2 |
| Connect flow steps 1-11 | 3.1, 3.3, 4.2, 5.3 |
| Auth-helper session lifecycle | 3.3 |
| Status flow | 3.2, 4.1, 5.1 |
| Hydration | 2.4, 3.4, 3.5 |
| Disconnect | 2.3, 3.2, 4.3 |
| Token refresh (via watcher) | 2.5, 2.6 |
| Security (Infisical paths, audit, redaction) | 1.3, 1.4, 1.5, 3.1 |
| Failure modes (timeout, error stream, cancel) | 2.2, 5.3 |
| Web UI (cards, modal, integrations page) | 5.1, 5.2, 5.3, 5.4 |
| Admin (audit, registry view) | 6.1, 6.2 |
| Testing (unit, integration, e2e) | embedded in each task + 7.1, 7.2 |
| Migration / rollout | 7.4 (cleanup) |
| File layout | matches the table in the spec |

No placeholders. Each step has runnable code or a runnable command. Types are consistent: `AgentTool`, `AgentChannel`, `OrchestratorEvent`, `AuthInbound`/`AuthOutbound`, `AgentStatus`, `AuditEntry` all appear in the tasks where they're used.

**Decisions made during planning** (not in spec but worth recording):

- **Per-session hydration is not audited.** The spec lists `hydrate` as a valid `agent_auth_audit.action`, but writing a row every session-active would generate one row per session-start across all users — that's noise, not audit. The column enum keeps `hydrate` so an admin-triggered force-hydrate could log to it later if useful. Only `connect`, `disconnect`, `refresh`, and `capture` are logged in this PR.
- **Vestigial column kept in DB, removed from code.** `user_credentials.claude_credentials` is unused; SQLite can't drop a column without rebuilding the table, so the column persists in old DBs. We strip the Drizzle field + add a comment marking it dead (Task 7.4). A future migration can compact the table.

Known assumptions the executor should verify on first task:
1. **Auth middleware names** (`requireUser`, `requireAdmin`) — these are the conventional names; if the existing middleware module uses different identifiers (e.g. `userOnly`, `adminOnly`), the executor should swap them in Task 4.1 and 6.1 before commit. Grep `packages/server/src/routes/auth.ts` for the export.
2. **`addColumnIfMissing` signature in `db/index.ts`** — used in Task 3.3 to add the `purpose` column. Confirm the helper matches the existing call sites near the bottom of `initDb()`.
3. **Web styles path** — Task 5.4 references `packages/web/src/styles.css`. The actual stylesheet may live elsewhere; use whatever the existing Integrations page imports from.

These are 5-minute checks at the relevant task; they don't change the plan.
