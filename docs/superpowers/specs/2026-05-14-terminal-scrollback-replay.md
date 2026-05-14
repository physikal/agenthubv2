# Terminal scrollback replay on reconnect

**Date:** 2026-05-14
**Status:** Approved for planning
**Pillar:** #2 (multi-session reliability) — slice 2a (browser reconnect with scrollback)

## Problem

A user closes a browser tab on an active AgentHub session and reopens the page. They see a **blank terminal**. The session is alive on the workspace (the `dtach` socket survived, `ttyd` is still proxying, the shell still has its working directory and environment), but the browser has no record of what's already happened on screen. The user has to type a character to trigger a winch event, force ttyd to redraw the visible viewport, and only then see anything — and even that recovery only shows the current screen, not the scrollback.

This is the #1 user-facing reliability gap to the stated user goal:

> "users can have a hosted coding VM that allows for multiple coding sessions to be running at any given time that they can leave, come back to and check on"

The "come back to" half breaks here. The session is **state-preserved** (dtach + restart-unless-stopped) but **view-not-preserved** (no replay buffer).

### Why the current implementation has the gap

`packages/server/src/ws/terminal-proxy.ts` proxies bytes browser↔ttyd in real time. It keeps no buffer of what flowed through. When the browser WS drops:
1. The server-side proxy closes both legs (browser leg + ttyd leg).
2. dtach + the underlying shell keep running unaffected.
3. ttyd is still listening on its workspace port.

When the browser reopens:
1. The server-side proxy opens a fresh ttyd WS connection.
2. ttyd connects to the existing dtach socket via `-A` flag.
3. dtach + ttyd attach but do NOT replay buffered output — `-r none` in the entrypoint script disables redraw on attach.
4. The browser sees an empty xterm.js viewport until the next live byte arrives.

The fix isn't on the workspace side (ttyd lacks a replay-buffer option in its protocol; `dtach -r ctrl_l` would force a `^L` clear+redraw on attach but only of the current screen). The fix lives at the **server proxy layer**, which is the natural place to track "what bytes have already been forwarded to a browser for this session."

## Goal

After this PR:

1. Close a browser tab on an active session and reopen the page: the terminal repopulates with the recent output (default last 256 KB) within ~1 second.
2. `useTerminal.ts` auto-reconnects with exponential backoff on WS close (1s → 2s → 4s → ... up to 30s).
3. Session ends → buffer is freed. No memory leak across many disconnect/reconnect cycles.
4. No regressions for live terminal use (typing, resize, multi-byte UTF-8, ANSI escapes).

## Non-goals

- Persistent scrollback across server reboots. The buffer lives in server-process memory and is intentionally not persisted. After a server crash, the dtach session still survives (slice 2a doesn't break it), but the replay buffer resets to empty for the first browser reconnect post-restart.
- Configurable per-user buffer sizes. Single install-wide setting via env var.
- Multi-browser-tab live mirroring. If two tabs both open the same session at the same time, both get the replay; they each see live output afterward. Existing behavior for concurrent tabs is unchanged.
- Replacement of dtach with tmux. Out of scope.
- Storing the buffer in the workspace agent or in dtach itself. Server-side is the right scope.

## Architecture

### Module: `packages/server/src/ws/terminal-buffer.ts` (new)

A `TerminalBuffer` class keyed on `sessionId`. Stores a fixed-capacity ring buffer of bytes. Three operations:

- `append(sessionId, bytes)` — push bytes into the ring. If capacity is reached, drop oldest bytes to make room (FIFO eviction). Per-session storage created on first `append`.
- `drain(sessionId): Buffer` — return all currently buffered bytes for replay. Does NOT clear the buffer (multiple reconnects each get the full replay).
- `free(sessionId)` — release the per-session storage. Called on session end or after a long idle period.

A central `terminalBuffers` singleton is exported, mounted at module scope, so `terminal-proxy.ts` can share it across all WS connections for a session.

Capacity is read once at module load from `AGENTHUB_TERMINAL_BUFFER_KB` env var, default 256 (KB). Lower bound: 16 KB (anything smaller defeats the purpose). Upper bound: 4096 KB (prevent runaway memory).

The implementation is a plain `Buffer` + write/read offsets. No external dependency.

### Modification: `packages/server/src/ws/terminal-proxy.ts`

Today's proxy flow (pseudocode):
```
browserWs ↔ proxy ↔ ttydWs

On every ttyd→proxy frame:
  proxy.writeToBrowser(frame)
```

New flow:
```
On every ttyd→proxy frame (data frame, type byte '0'):
  proxy.writeToBrowser(frame)
  terminalBuffers.append(sessionId, frame.dataBytes)

On browser WS open:
  // Send replay BEFORE starting the live ttyd proxy
  const replay = terminalBuffers.drain(sessionId)
  if (replay.length > 0) {
    proxy.writeToBrowser({ type: '0', data: replay })
  }
  // ... existing flow: open ttyd WS, start proxying
```

Type-byte filtering: only buffer `'0'` (data) frames. Skip `'1'` (set window title) and `'2'` (preferences). Replay sends a single `'0'` frame containing the concatenated buffer.

### Modification: `packages/web/src/hooks/useTerminal.ts`

Today: on WS close, the hook closes the xterm.js side and stops. No retry.

After: on WS close that wasn't user-initiated (i.e., not a "session ended" event from the server):
- Wait `min(2^attempts * 1000, 30000)` ms (1s, 2s, 4s, ..., capped at 30s).
- Reopen the WS.
- xterm.js receives the server's replay on connect — no special handling needed (replay arrives as a normal data frame).
- Reset attempt counter on successful connect.

A small visual affordance: a thin "Reconnecting…" banner above the terminal during retry, cleared on successful connect.

### Sizing the buffer

The default `AGENTHUB_TERMINAL_BUFFER_KB=256` (262144 bytes) covers approximately:
- ~3000 lines of 80-char output, OR
- ~1500 lines with moderate ANSI styling.

For most "come back after lunch" cases, that's plenty. Larger outputs (e.g., running `npm install` then walking away) may overflow — the oldest bytes drop, the user sees the tail of the output. This is consistent with most terminal multiplexers and is acceptable for the goal.

Per the spec architecture sizing in the brainstorm: 3 sessions/user × ~10 active users × 256 KB ≈ 7.5 MB total — trivial.

Memory bound is hard: `min(buffered_bytes, capacity)`. Never exceeds capacity even for a session that's been running for days.

### Why server-side, not workspace-side

Three alternatives considered + rejected:

1. **Modify ttyd**: ttyd has no replay-buffer option. Forking it adds maintenance burden.
2. **Buffering proxy inside workspace**: a small Node/Go process between dtach and ttyd that records output. Adds a hop on the hot path inside every session container. More moving parts.
3. **Switch to tmux**: tmux's `tmux attach` replays the scrollback automatically. But tmux is a much bigger surface than dtach (clients, panes, sessions-vs-windows-vs-panes model) and changes the workspace runtime substantially. Out of scope.

The server-side proxy already sits in the data path. Buffering there is one focused change in one file.

## Edge cases + handling

- **Concurrent browser tabs**: if a user opens two tabs on the same session, both get the replay on connect, then both see live output. No coordination needed — `drain` is non-destructive.
- **Disconnect during a long-running command**: bytes that arrived while the browser was offline accumulate in the ring. On reconnect, the user sees them. If the command is still printing, live bytes continue normally.
- **UTF-8 byte boundaries**: dropping oldest bytes from the ring may split a multi-byte UTF-8 character. xterm.js handles invalid bytes gracefully (renders replacement char). Not perfect but acceptable; could be improved later by aligning to UTF-8 boundaries on eviction.
- **Massive output bursts**: `cat huge_file` floods the proxy. Each byte is appended once; the ring evicts oldest. No backpressure issue.
- **Session ends mid-replay**: if the user reconnects, gets the replay, and the session ends before the replay finishes streaming, the server-side close handler still runs. Buffer is freed. The browser sees the replay up to whenever the WS closed, then sees "session ended."
- **Server reboot**: in-memory buffer is lost. First browser reconnect post-reboot sees only post-reboot live output. Documented as a known limitation.
- **xterm.js viewport size mismatch**: on connect, the browser sends its current cols/rows to the server via the existing winch frame path. The server forwards to ttyd AFTER sending the replay. Replayed cursor positions assume the original size; if the user resized between disconnects, the replayed output may render slightly misaligned. Acceptable.

## Testing strategy

**Unit tests** (`packages/server/src/ws/terminal-buffer.test.ts`):
- Empty buffer: drain returns empty
- Append below capacity: drain returns appended bytes verbatim
- Append over capacity: oldest bytes are evicted; drain returns most-recent `capacity` bytes
- Multiple drains: each drain returns full content (non-destructive)
- Free: subsequent drain returns empty
- Multiple sessions: buffers are isolated by sessionId
- Capacity from env var: respects `AGENTHUB_TERMINAL_BUFFER_KB`
- Capacity bounds: clamps to [16, 4096] KB

**Integration test** (`scripts/e2e-full.js`):
- Open WS to a session, send `echo HELLO_REPLAY` command via terminal, wait for output.
- Close WS.
- Reopen WS to same session.
- Read the first chunk of bytes; assert it contains `HELLO_REPLAY`.

**Manual VM verify**:
- VM with running session: `seq 1 200 | head -50` in the terminal.
- Close browser tab.
- Reopen the session URL.
- Without typing anything, confirm the last ~50 lines are visible in the terminal.

## File layout

```
packages/server/src/ws/
  terminal-buffer.ts          // new: TerminalBuffer class + terminalBuffers singleton
  terminal-buffer.test.ts     // new
  terminal-proxy.ts            // modify: integrate buffer append + drain

packages/web/src/hooks/
  useTerminal.ts               // modify: auto-reconnect with backoff

scripts/e2e-full.js            // modify: add scrollback replay assertion

docs/operations/terminal-replay.md  // optional: operator note re. AGENTHUB_TERMINAL_BUFFER_KB env var
```

## Risks + open questions

- **Memory accounting**: each session keeps its own ring buffer. If a server has many concurrent sessions (e.g., dozens), memory grows linearly. Hard cap = `numActiveSessions × bufferKB`. Documented; default 256 KB is conservative.
- **xterm.js renders correctly on replay?** Standard usage assumes it does — xterm.js processes incoming bytes one at a time, regardless of source. The replay is just a bigger initial chunk. Verify in e2e.
- **Reconnect-while-still-connected race**: if the browser tab is reopened in a second tab before the first tab's WS has fully closed (browser may keep WSocket alive briefly during tab close), both WSockets are open simultaneously. Existing behavior handles this (the proxy sends bytes to both); the new buffer just adds replay on the new tab. No new race introduced.
- **AGENTHUB_TERMINAL_BUFFER_KB env var lifecycle**: read at module load. Operator changes it → must restart the server container for the new value to take effect. Documented.

## How to apply

After this spec merges:

1. Run `superpowers:writing-plans` against this spec to produce `docs/superpowers/plans/2026-05-14-terminal-scrollback-replay-impl.md`.
2. Execute on a feature branch `feat/terminal-scrollback-replay`.
3. Manual VM verification (above) before merging the impl PR.
4. After merge: pillar #2 still has slices 2b (live status push), 2c (idle timeout), 2d (orphan reaper), 2e (multi-user workspace safety) open. Slice 2b is the next-highest-impact piece.
