# Terminal Scrollback Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the blank-terminal-on-reload UX bug by adding a server-side per-session ring buffer that's appended on every ttyd→browser byte and drained to the browser on each new WS connection.

**Architecture:** New module `packages/server/src/ws/terminal-buffer.ts` exports a `TerminalBuffer` singleton keyed on session ID. `terminal-proxy.ts` integrates: on every data frame from ttyd, append the data bytes (post-type-byte-strip) to the buffer for that session, then forward to the browser. On new browser WS connection, drain the buffer and send to the browser BEFORE forwarding live ttyd output. Client (`useTerminal.ts`) gains exponential-backoff auto-reconnect on WS close.

**Tech Stack:** TypeScript (Node 22, ESM), Hono server (only routes; this slice is in raw WS via `ws` package), vitest, React 19 + xterm.js for the browser.

**Reference spec:** `docs/superpowers/specs/2026-05-14-terminal-scrollback-replay.md`

---

## Pre-flight

- [ ] **Step 0.1: Confirm clean working tree, on `main`**

Run: `git status && git log --oneline -3`
Expected: clean. If the spec PR #77 has merged, HEAD should include the spec on main.

- [ ] **Step 0.2: Switch to impl branch**

The plan should already be on `feat/terminal-scrollback-replay` (committed as part of this PR). Confirm:
```bash
git branch --show-current  # → feat/terminal-scrollback-replay
```

- [ ] **Step 0.3: Run baseline tests**

Run: `pnpm install && pnpm test`
Expected: all tests pass.

- [ ] **Step 0.4: Run baseline typecheck**

Run: `pnpm typecheck`
Expected: passes.

---

## Task 1: TerminalBuffer module + tests (TDD)

**Files:**
- Create: `packages/server/src/ws/terminal-buffer.ts`
- Create: `packages/server/src/ws/terminal-buffer.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Create `packages/server/src/ws/terminal-buffer.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TerminalBuffer, getBufferCapacityBytes } from "./terminal-buffer.js";

describe("TerminalBuffer", () => {
  it("returns empty for a session with no appends", () => {
    const b = new TerminalBuffer(1024);
    expect(b.drain("s1").length).toBe(0);
  });

  it("append below capacity: drain returns appended bytes verbatim", () => {
    const b = new TerminalBuffer(1024);
    b.append("s1", Buffer.from("hello world"));
    expect(b.drain("s1").toString()).toBe("hello world");
  });

  it("append over capacity: oldest bytes are evicted", () => {
    const b = new TerminalBuffer(10);
    b.append("s1", Buffer.from("0123456789ABCDEF")); // 16 bytes into capacity 10
    expect(b.drain("s1").toString()).toBe("6789ABCDEF");
  });

  it("multiple appends accumulate", () => {
    const b = new TerminalBuffer(1024);
    b.append("s1", Buffer.from("foo"));
    b.append("s1", Buffer.from("bar"));
    expect(b.drain("s1").toString()).toBe("foobar");
  });

  it("multiple appends with eviction stay consistent", () => {
    const b = new TerminalBuffer(5);
    b.append("s1", Buffer.from("abc"));
    b.append("s1", Buffer.from("defgh"));
    // capacity 5: "abc"+"defgh"=8 bytes, evict 3, keep last 5
    expect(b.drain("s1").toString()).toBe("defgh");
  });

  it("drain is non-destructive (multiple drains return full content)", () => {
    const b = new TerminalBuffer(1024);
    b.append("s1", Buffer.from("hello"));
    expect(b.drain("s1").toString()).toBe("hello");
    expect(b.drain("s1").toString()).toBe("hello");
  });

  it("free releases per-session storage", () => {
    const b = new TerminalBuffer(1024);
    b.append("s1", Buffer.from("hello"));
    b.free("s1");
    expect(b.drain("s1").length).toBe(0);
  });

  it("sessions are isolated", () => {
    const b = new TerminalBuffer(1024);
    b.append("s1", Buffer.from("hello"));
    b.append("s2", Buffer.from("world"));
    expect(b.drain("s1").toString()).toBe("hello");
    expect(b.drain("s2").toString()).toBe("world");
  });
});

describe("getBufferCapacityBytes", () => {
  const origEnv = process.env["AGENTHUB_TERMINAL_BUFFER_KB"];
  afterEach(() => {
    if (origEnv === undefined) delete process.env["AGENTHUB_TERMINAL_BUFFER_KB"];
    else process.env["AGENTHUB_TERMINAL_BUFFER_KB"] = origEnv;
  });

  it("defaults to 256 KB when env var unset", () => {
    delete process.env["AGENTHUB_TERMINAL_BUFFER_KB"];
    expect(getBufferCapacityBytes()).toBe(256 * 1024);
  });

  it("reads env var value in KB", () => {
    process.env["AGENTHUB_TERMINAL_BUFFER_KB"] = "512";
    expect(getBufferCapacityBytes()).toBe(512 * 1024);
  });

  it("clamps to lower bound (16 KB)", () => {
    process.env["AGENTHUB_TERMINAL_BUFFER_KB"] = "1";
    expect(getBufferCapacityBytes()).toBe(16 * 1024);
  });

  it("clamps to upper bound (4096 KB)", () => {
    process.env["AGENTHUB_TERMINAL_BUFFER_KB"] = "999999";
    expect(getBufferCapacityBytes()).toBe(4096 * 1024);
  });

  it("falls back to default on invalid value", () => {
    process.env["AGENTHUB_TERMINAL_BUFFER_KB"] = "not-a-number";
    expect(getBufferCapacityBytes()).toBe(256 * 1024);
  });
});
```

- [ ] **Step 1.2: Run failing tests**

Run: `pnpm --filter @agenthub/server exec vitest run src/ws/terminal-buffer.test.ts`
Expected: fails — module not found.

- [ ] **Step 1.3: Implement TerminalBuffer**

Create `packages/server/src/ws/terminal-buffer.ts`:
```typescript
const DEFAULT_CAPACITY_KB = 256;
const MIN_CAPACITY_KB = 16;
const MAX_CAPACITY_KB = 4096;

export function getBufferCapacityBytes(): number {
  const raw = process.env["AGENTHUB_TERMINAL_BUFFER_KB"];
  if (!raw) return DEFAULT_CAPACITY_KB * 1024;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CAPACITY_KB * 1024;
  const clamped = Math.min(Math.max(n, MIN_CAPACITY_KB), MAX_CAPACITY_KB);
  return clamped * 1024;
}

/**
 * Per-session ring buffer of bytes that flowed through the terminal proxy
 * to the browser. On a fresh browser WS connection, `drain` is called to
 * replay this content before live forwarding starts. Drain is intentionally
 * non-destructive so concurrent or sequential reconnects each get the
 * full replay.
 */
export class TerminalBuffer {
  private buffers = new Map<string, Buffer>();
  private capacity: number;

  constructor(capacity = getBufferCapacityBytes()) {
    this.capacity = capacity;
  }

  append(sessionId: string, chunk: Buffer): void {
    const existing = this.buffers.get(sessionId);
    if (!existing) {
      // First chunk: clip to capacity right away.
      this.buffers.set(
        sessionId,
        chunk.length <= this.capacity
          ? Buffer.from(chunk)
          : chunk.subarray(chunk.length - this.capacity),
      );
      return;
    }
    const combined = Buffer.concat([existing, chunk]);
    if (combined.length <= this.capacity) {
      this.buffers.set(sessionId, combined);
    } else {
      this.buffers.set(sessionId, combined.subarray(combined.length - this.capacity));
    }
  }

  drain(sessionId: string): Buffer {
    return this.buffers.get(sessionId) ?? Buffer.alloc(0);
  }

  free(sessionId: string): void {
    this.buffers.delete(sessionId);
  }
}

/**
 * Module-level singleton. Used by terminal-proxy.ts.
 */
export const terminalBuffers = new TerminalBuffer();
```

- [ ] **Step 1.4: Run the tests (passing)**

Run: `pnpm --filter @agenthub/server exec vitest run src/ws/terminal-buffer.test.ts`
Expected: 13 tests pass.

- [ ] **Step 1.5: Commit**

```bash
git add packages/server/src/ws/terminal-buffer.ts packages/server/src/ws/terminal-buffer.test.ts
git commit -m "feat(ws): TerminalBuffer module + tests"
```

---

## Task 2: Integrate buffer into terminal-proxy.ts

**Files:**
- Modify: `packages/server/src/ws/terminal-proxy.ts`

The current proxy strips the ttyd type byte and forwards `buf.subarray(1)` to the browser (line 102). The buffer must capture exactly those bytes, AND a fresh browser connection must replay them BEFORE the live forward starts.

- [ ] **Step 2.1: Import the buffer singleton**

In `packages/server/src/ws/terminal-proxy.ts` at the top (after existing imports):
```typescript
import { terminalBuffers } from "./terminal-buffer.js";
```

- [ ] **Step 2.2: Send replay on browser connect**

Inside `handleBrowserConnection` (around line 71), AFTER the `if (!session?.workspaceIp) ...` guard but BEFORE constructing the `ttydUrl` (i.e., right at the start of the function body), add:
```typescript
// Replay buffered scrollback to the browser before any live ttyd traffic.
const replay = terminalBuffers.drain(sessionId);
if (replay.length > 0) {
  browserWs.send(replay, { binary: true });
}
```

This sends the replay as a single binary frame (xterm.js handles it as one big chunk of input).

- [ ] **Step 2.3: Append data frames to the buffer**

Find the ttyd→browser data frame handler (around line 96-103):
```typescript
ttydWs.on("message", (data, isBinary) => {
  if (browserWs.readyState !== WebSocket.OPEN) return;
  if (!isBinary) return;
  const buf = Buffer.from(data as ArrayBuffer);
  if (buf.length < 2) return;
  if (buf[0] === 0x30) {
    if (browserWs.bufferedAmount > BACKPRESSURE_BYTES) return;
    browserWs.send(buf.subarray(1), { binary: true });
  }
});
```

Replace with:
```typescript
ttydWs.on("message", (data, isBinary) => {
  if (!isBinary) return;
  const buf = Buffer.from(data as ArrayBuffer);
  if (buf.length < 2) return;
  if (buf[0] === 0x30) {
    const payload = buf.subarray(1);
    // Always append to the buffer, even if the browser is currently
    // backpressured or closed — the buffer is the durable scrollback
    // that survives reconnects, independent of the live WS state.
    terminalBuffers.append(sessionId, payload);
    if (browserWs.readyState !== WebSocket.OPEN) return;
    if (browserWs.bufferedAmount > BACKPRESSURE_BYTES) return;
    browserWs.send(payload, { binary: true });
  }
});
```

Note the move of the `browserWs.readyState` check to AFTER the append — buffer captures bytes even when the browser is offline, which is the whole point.

- [ ] **Step 2.4: Free buffer when session ends**

The proxy itself doesn't know "when the session ends" — that's `SessionManager.endSession()`. Find it:
```bash
grep -n "endSession\|destroy.*session" packages/server/src/services/session-manager.ts | head
```

In `SessionManager.endSession()` (or wherever a session reaches terminal status `completed` / `failed`), add right before any cleanup return:
```typescript
const { terminalBuffers } = await import("../ws/terminal-buffer.js");
terminalBuffers.free(sessionId);
```

(Use dynamic import to avoid creating a hard dependency between the session manager and the ws module if there isn't one already.)

- [ ] **Step 2.5: Run typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 2.6: Run tests**

Run: `pnpm --filter @agenthub/server test`
Expected: all server tests pass (terminal-buffer tests + existing tests).

- [ ] **Step 2.7: Commit**

```bash
git add packages/server/src/ws/terminal-proxy.ts packages/server/src/services/session-manager.ts
git commit -m "feat(ws): integrate scrollback buffer; replay on connect, free on end"
```

---

## Task 3: Browser auto-reconnect (useTerminal.ts)

**Files:**
- Modify: `packages/web/src/hooks/useTerminal.ts`

Today's hook closes the xterm.js terminal on WS close with a `[disconnected]` line and stops. After this task: on close, schedule a reconnect with exponential backoff up to 30s.

- [ ] **Step 3.1: Add reconnect state**

In `useTerminal.ts`, at the top of the hook body (around line 12-16), add:
```typescript
const reconnectAttemptRef = useRef(0);
const reconnectTimerRef = useRef<number | null>(null);
const userClosedRef = useRef(false);
```

- [ ] **Step 3.2: Refactor the connect logic into a function**

Today the WS construction happens inline in `attach`. Extract it into a `connect` helper inside the hook so reconnect can call it again. Pseudocode of the refactor:

```typescript
const connect = (): void => {
  if (userClosedRef.current) return;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws/sessions/${options.sessionId}/terminal`;
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";
  wsRef.current = ws;

  ws.addEventListener("open", () => {
    reconnectAttemptRef.current = 0;
    // ... existing open handler body
  });

  // ... existing message handler unchanged (replay arrives as a normal data frame)

  ws.addEventListener("close", () => {
    if (userClosedRef.current) {
      termRef.current?.write("\r\n\x1b[33m[disconnected]\x1b[0m\r\n");
      return;
    }
    const attempt = reconnectAttemptRef.current;
    const delay = Math.min(Math.pow(2, attempt) * 1000, 30000);
    termRef.current?.write(`\r\n\x1b[33m[reconnecting in ${delay / 1000}s...]\x1b[0m\r\n`);
    reconnectAttemptRef.current = attempt + 1;
    reconnectTimerRef.current = window.setTimeout(connect, delay);
  });

  // ... existing term.onData and term.onResize handlers
  //     (these reference `ws`, so they need to be inside connect)
};

// In attach(): call connect() at the end.
connect();
```

The trick: `term.onData` and `term.onResize` register listeners on `term`, but they reference `ws` via closure. After reconnect, `wsRef.current` points to the new WS — but the closure captured the OLD ws. Fix: have the handlers read from `wsRef.current` instead of a closed-over `ws`:

```typescript
term.onData((data) => {
  const ws = wsRef.current;
  if (ws && ws.readyState === WebSocket.OPEN) {
    // existing body
  }
});
```

Same for `term.onResize`. Register these ONCE in `attach`, NOT inside `connect`.

- [ ] **Step 3.3: Cleanup on unmount**

In the existing `cleanupRef` / unmount handler, also clear the reconnect timer:
```typescript
userClosedRef.current = true;
if (reconnectTimerRef.current !== null) {
  window.clearTimeout(reconnectTimerRef.current);
  reconnectTimerRef.current = null;
}
```

- [ ] **Step 3.4: Web typecheck**

Run: `pnpm --filter @agenthub/web exec tsc --noEmit`
Expected: passes.

- [ ] **Step 3.5: Web build**

Run: `pnpm --filter @agenthub/web build`
Expected: succeeds.

- [ ] **Step 3.6: Commit**

```bash
git add packages/web/src/hooks/useTerminal.ts
git commit -m "feat(web): auto-reconnect terminal WS with exponential backoff"
```

---

## Task 4: E2E scrollback replay test

**Files:**
- Modify: `scripts/e2e-full.js`

- [ ] **Step 4.1: Read the existing e2e test structure**

Run: `grep -n "WebSocket\|new WebSocket\|/ws/sessions" scripts/e2e-full.js | head -10`
Note: if there's no existing WebSocket test, you'll need to add the `ws` package usage. Node 22 has built-in WebSocket; use that.

- [ ] **Step 4.2: Append the scrollback test**

After the existing tests in `scripts/e2e-full.js`, add:
```javascript
async function testScrollbackReplay(baseUrl, cookie, sessionId) {
  console.log("[e2e] scrollback replay test");
  const wsProto = baseUrl.startsWith("https://") ? "wss://" : "ws://";
  const wsHost = baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const wsUrl = `${wsProto}${wsHost}/ws/sessions/${sessionId}/terminal`;

  // First connection: send a command and collect output
  const ws1 = new WebSocket(wsUrl, { headers: { Cookie: cookie } });
  await new Promise((resolve, reject) => {
    ws1.addEventListener("open", resolve);
    ws1.addEventListener("error", reject);
  });

  // Send command: echo HELLO_REPLAY_<uuid> (type byte '0' = input)
  const marker = `HELLO_REPLAY_${Math.random().toString(36).slice(2, 10)}`;
  const cmd = `echo ${marker}\n`;
  const inBuf = new Uint8Array(cmd.length + 1);
  inBuf[0] = 0x30;
  for (let i = 0; i < cmd.length; i++) inBuf[i + 1] = cmd.charCodeAt(i);
  ws1.send(inBuf.buffer);

  // Wait for the marker in incoming data
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`marker ${marker} not seen on first connect`)), 5000);
    ws1.addEventListener("message", (e) => {
      const text = Buffer.from(e.data).toString();
      if (text.includes(marker)) { clearTimeout(timer); resolve(); }
    });
  });

  ws1.close();
  await new Promise((r) => setTimeout(r, 200)); // grace period for server-side close

  // Second connection: expect the marker in the first batch of bytes (replay)
  const ws2 = new WebSocket(wsUrl, { headers: { Cookie: cookie } });
  await new Promise((resolve, reject) => {
    ws2.addEventListener("open", resolve);
    ws2.addEventListener("error", reject);
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`marker ${marker} not in replay`)), 5000);
    ws2.addEventListener("message", (e) => {
      const text = Buffer.from(e.data).toString();
      if (text.includes(marker)) { clearTimeout(timer); resolve(); }
    });
  });

  ws2.close();
  console.log(`[e2e] scrollback replay OK (marker ${marker})`);
}
```

Wire into the main flow after a session has been created and is `active`. The session ID and cookie are already available in the existing test flow.

- [ ] **Step 4.3: Syntax-check the e2e script**

Run: `node --check scripts/e2e-full.js`
Expected: no syntax errors.

- [ ] **Step 4.4: Commit**

```bash
git add scripts/e2e-full.js
git commit -m "test(e2e): scrollback replay round-trip"
```

---

## Task 5: Final sweep + open PR

- [ ] **Step 5.1: Full test suite**

Run: `pnpm test`
Expected: all tests pass. New: 13 buffer tests.

- [ ] **Step 5.2: Typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 5.3: Lint (where applicable)**

Run: `pnpm lint`
Expected: passes.

- [ ] **Step 5.4: Sanity-grep for `terminalBuffers.append` callsites**

Run:
```bash
grep -rn "terminalBuffers\." packages/server/src
```
Expected: exactly 3 callsites — `append` in terminal-proxy.ts, `drain` in terminal-proxy.ts, `free` in session-manager.ts. If more or fewer, something is mis-wired.

- [ ] **Step 5.5: Open the PR**

```bash
git push -u origin feat/terminal-scrollback-replay
gh pr create --title "feat(ws): terminal scrollback replay on reconnect (pillar #2 slice 2a)" --body "$(cat <<'EOF'
## Summary

Implements `docs/superpowers/specs/2026-05-14-terminal-scrollback-replay.md` (PR #77).

Closes the **blank-terminal-on-reload UX bug**. Server-side per-session ring buffer (default 256 KB) captures every byte that flows through the proxy to the browser. On a fresh browser WS connection, the buffer is replayed BEFORE live forwarding starts. Client gains exponential-backoff auto-reconnect so close→reopen takes ~1 second.

## What's in this PR

- New `packages/server/src/ws/terminal-buffer.ts` — `TerminalBuffer` class + module singleton + env-var-driven capacity (`AGENTHUB_TERMINAL_BUFFER_KB`, default 256, clamped to [16, 4096] KB)
- 13 unit tests for the buffer
- Integration into `terminal-proxy.ts`: append on every data frame; drain + send on browser connect; free on session end
- `useTerminal.ts` auto-reconnects with 1s → 30s exponential backoff
- E2E test: send command, close WS, reopen WS, assert marker visible in replay

## Test plan

- [ ] `pnpm test` passes — 13 new unit tests
- [ ] `pnpm typecheck` passes
- [ ] Manual VM: open a session, type `seq 1 100`, close browser tab, reopen → confirm output is visible without typing

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5.6: Verify CI / report**

Run: `gh pr checks`
Expected: no checks configured (per CLAUDE.md). That's fine.

---

## Post-implementation (out of plan scope)

- **Manual VM verification**: on VM 923 (current prod) — start a session, output some text, close tab, reopen, confirm replay.
- **Slice 2b next**: SSE-push of session status to the Sessions page so the user sees live updates without page reload.
