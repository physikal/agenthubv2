# Agent CLI Auth Integration

**Status:** Implemented in PR #90 (`78a018c`)
**Date:** 2026-05-14
**Owner:** boodyjenkins@gmail.com

## Problem

Today, authenticating coding-agent CLIs (`claude`, `codex`, `gh`, etc.) inside a workspace session is a manual terminal dance: the user opens a session, runs `claude /login`, copy-pastes a long OAuth URL out of the ttyd terminal into a real browser tab, completes the OAuth, and returns. They have to *discover* this step exists, the copy-paste UX is fragile, and the Integrations page in AgentHub gives no indication of which agents are connected.

Per-user persistence is already half-solved by the `agenthub-home-${userId}` volume mounted at `/home/coder` on every session (see `packages/server/src/services/session-manager.ts:285`) — credential files written by these CLIs already survive across sessions. The remaining gap is **surfacing** and **guiding**: making the Integrations page reflect real auth state, and turning the one-time login into a clear, web-driven flow that doesn't require terminal use.

API-key paths for `ai-anthropic`, `ai-minimax`, and `ai-openai` are already wired via `infrastructure_configs` + Infisical and injected as env vars at session start. This design adds an **OAuth/subscription path** alongside the existing API-key path, and generalizes it to any CLI tool that has a `/login` flow.

## Goals

- One-click connect for any supported agent CLI from the Integrations page.
- Reliable: uses each CLI's own auth flow (no reverse-engineering of OAuth internals).
- Consistent: identical UX across `claude`, `codex`, `gh`, and future tools (`aider`, `gemini`, `cursor`, …).
- Durable: credentials survive volume destruction, install backup/restore, and VM migration.
- Extensible: adding a new CLI is a registry entry, not a code change.
- Honest status: Integrations cards always reflect real captured-credential state.

## Non-goals

- Reverse-engineering CLI-tool-specific OAuth clients to enable server-mediated browser flows (Option B from the brainstorm — rejected on reliability and consistency grounds).
- Multi-account-per-tool support. One credential per `(user, tool)` pair. A user who wants to switch accounts disconnects and reconnects.
- Replacing the existing API-key paths (`ai-anthropic`, `ai-minimax`, `ai-openai`). The new flow lives alongside them. A user with both an API key and a captured OAuth credential gets the OAuth path (the credential file in the home volume wins; the API-key env var becomes a fallback only used if no credential file exists).
- A general-purpose secrets manager UI. This is scoped to agent-CLI auth.
- Pre-warming auth-helper sessions. The 5-15s cold-start cost is acceptable for a once-per-tool-ever flow.

## Architecture

```
┌─────────────────────────┐         ┌─────────────────────────┐
│  Web UI / Integrations  │ ──SSE── │  Server /api/integ…     │
│  AgentLoginModal        │         │  agent-auth orchestrator│
└─────────────────────────┘         └──────────┬──────────────┘
                                               │  WS (existing)
                                               ▼
                              ┌────────────────────────────────┐
                              │  Ephemeral auth-helper session │
                              │  ┌──────────────────────────┐  │
                              │  │  Agent daemon            │  │
                              │  │   ├─ auth handler        │  │
                              │  │   └─ cred-watcher        │  │
                              │  │  spawns: claude /login   │  │
                              │  │  writes: ~/.claude/…     │  │
                              │  └──────────────────────────┘  │
                              │  Volume: agenthub-home-${uid}  │
                              └────────────────────────────────┘
                                               │
                                               ▼
                              ┌────────────────────────────────┐
                              │  Infisical (durable mirror)    │
                              │  /users/{uid}/agents/{tool}/   │
                              └────────────────────────────────┘
```

Three principles:

1. **Never reverse-engineer a CLI's auth flow.** Always invoke the CLI's own `/login` and let it do its thing. If `claude /login` works on a laptop, it works here.
2. **Persist twice.** The per-user volume gives free hydration on every session start; Infisical gives durability across volume loss.
3. **Registry-driven.** Each supported CLI is described declaratively. Adding Aider tomorrow is a config entry, not new code.

## Tool registry

Static table in `packages/server/src/services/agent-auth/registry.ts`:

```ts
export type AgentTool = {
  id: string;                   // "claude-code"
  displayName: string;          // "Claude Code"
  loginCommand: string;         // "claude /login"
  logoutCommand?: string;       // "claude /logout" (else rm credentialPaths)
  credentialPaths: string[];    // ["/home/coder/.claude/.credentials.json"]
  urlPattern: RegExp;           // matches the OAuth URL the CLI prints to stdout
  loginTimeoutSec: number;      // default 300
  expiryParser?: (file: string) => Date | null;  // optional, for "expires in 6 days" display
};
```

**v1 ships exactly three tools** — the ones whose login flows are known to print a parseable browser URL:

| id            | loginCommand          | credentialPath                          | urlPattern (sketch)                                |
|---------------|-----------------------|------------------------------------------|----------------------------------------------------|
| `claude-code` | `claude /login`       | `~/.claude/.credentials.json`            | `/https:\/\/claude\.ai\/oauth\/authorize\?[^\s]+/` |
| `codex`       | `codex login`         | `~/.codex/auth.json`                     | `/https:\/\/auth\.openai\.com\/[^\s]+/`            |
| `gh`          | `gh auth login --web` | `~/.config/gh/hosts.yml`                 | `/https:\/\/github\.com\/login\/device/`           |

Exact URL patterns and credential paths are confirmed against real CLI output captured during implementation, with snapshot fixtures in `packages/server/src/services/agent-auth/__fixtures__/`. Any tool whose actual output doesn't match a single-URL pattern gets either a custom handler or is dropped from v1.

**Deferred to v2** (in this order): `aider`, `gemini`, `cursor`. Each is added only after a fixture-collection pass confirms the login flow prints a parseable URL. Tools whose auth doesn't fit the pattern (device-code flows that don't print a URL, TUI-prompted API keys, etc.) get the existing API-key path via `infrastructure_configs` instead.

`loginCommand` is executed by the agent daemon as the `coder` user inside the workspace container — same user the CLI runs as in normal use, so the credential file lands at the right path with the right ownership.

## Connect flow

1. User clicks **Connect** on (e.g.) the Claude Code card in the Integrations page.
2. Web UI opens `AgentLoginModal`, which establishes an SSE connection to `POST /api/integrations/agents/claude-code/connect`.
3. Server `orchestrator.connect(userId, toolId)`:
   - Spawns an ephemeral auth-helper session via the existing `SessionManager` (always ephemeral — see "Auth-helper session lifecycle" below).
   - Waits for the session to reach `active` (~5-15s; the modal shows "Preparing secure auth helper…" with a spinner).
   - Sends `{type: "auth.connect", tool: "claude-code"}` over the existing agent WS.
4. Agent daemon (`packages/agent/src/auth/handler.ts`):
   - Spawns `claude /login` under daemon control (not in any user-visible terminal).
   - Streams stdout and stderr line-by-line back to the server over WS.
5. Server forwards lines to the web UI as SSE events.
6. Web UI runs each line through `tool.urlPattern`; on first match, the modal transitions from spinner to a large **"Open Claude login →"** button anchored to the matched URL.
7. User clicks the button → URL opens in their normal browser tab → they're already signed into claude.ai → callback completes inside the workspace's `claude /login` process → CLI writes `~/.claude/.credentials.json` and exits 0.
8. The daemon's `cred-watcher` (`fs.watch` on each registered `credentialPath`) detects the write, reads the file, sends `{type: "auth.captured", tool: "claude-code", file: "/home/coder/.claude/.credentials.json", contents: <base64>}` to the server.
9. Server stores the file at `/users/{userId}/agents/claude-code/credentials.json` in Infisical (using the existing Infisical client; no new infra).
10. Server sends `{type: "session.destroy"}` for the auth-helper session.
11. Modal shows ✓ "Connected" with the parsed expiry (if available) and closes after 2s.

If the user cancels the modal at any point, the server sends `{type: "auth.cancel"}` to the daemon (which kills the `claude /login` subprocess), then destroys the auth-helper session.

## Auth-helper session lifecycle

Always ephemeral, never reused. Rationale (decided in brainstorm):

- **Stale-process trap**: a `claude` process already running in a user's active session keeps using the old credentials in memory; reusing that session would surface "Connected ✓" in the UI but `claude` would still act unauthorized in their open terminal.
- **Watcher noise**: a watcher running in the user's active session could trigger on unrelated credential changes (manual refresh, parallel `/login` in another terminal). Ephemeral guarantees the capture is unambiguously tied to the orchestrated flow.
- **Env contamination**: user-set env vars (`ANTHROPIC_API_KEY`, `HTTPS_PROXY`, etc.) could change how the CLI's login behaves. Ephemeral gives a deterministic env every time.
- **Concurrency**: two simultaneous Connect attempts get two independent sessions instead of racing.

Cost: 5-15s per Connect, surfaced honestly with "Preparing secure auth helper…". Acceptable for a once-per-tool-ever flow.

The auth-helper session mounts the same `agenthub-home-${userId}` volume as user sessions, so the credential file lands in the durable location automatically (and the user's next regular session sees it without any extra hydration step). Sessions are marked `purpose: "agent-auth"` in the DB so they don't show up in the Sessions UI.

## Status flow

`GET /api/integrations/agents`:

- For each tool in the registry:
  - Check Infisical for `/users/{userId}/agents/{toolId}/credentials.json`.
  - If present, parse expiry via `tool.expiryParser` if defined.
  - Return `{id, displayName, status: "connected" | "disconnected", lastSeen, expiresAt?}`.

Pure read against Infisical. No session spin-up. Fast (cache-friendly).

## Hydration flow

When a regular (non-auth-helper) session reaches `active`:

1. `SessionManager` calls `credentialSync.hydrate(session)`.
2. Server sends `{type: "auth.hydrate"}` to the daemon.
3. Daemon checks each registered `credentialPath` for presence in the mounted volume.
4. For any path missing, daemon sends `{type: "auth.requestHydrate", tool: "claude-code"}`.
5. Server fetches the credential from Infisical and replies `{type: "auth.hydrateData", tool, file, contents}`.
6. Daemon writes the file to the right path with correct perms (`0600`, owned by `coder`).

This is the recovery path for fresh volumes (new install, restored install backup, manually deleted volume). For users whose volume already has the file, it's a no-op — the daemon sees the file is present and skips. Idempotent.

## Disconnect flow

`POST /api/integrations/agents/:toolId/disconnect`:

1. Server checks if the user has an active session. If yes, send `{type: "auth.disconnect", tool}` to that daemon. If no, spawn an ephemeral auth-helper session to do it.
2. Daemon runs `logoutCommand` if defined (which typically also revokes upstream), else just `rm` each `credentialPath`.
3. Server deletes the Infisical entry at `/users/{userId}/agents/{toolId}/credentials.json`.
4. Server writes an audit log entry.
5. Auth-helper session (if spawned) is destroyed.

Reuse of an active session is acceptable here (unlike connect) because the failure modes that drove always-ephemeral for connect don't apply to disconnect: there's no URL to parse, no watcher noise to disambiguate, and any in-memory CLI process losing access *is the desired outcome*. Skipping the 5-15s spin-up when a session is already active is a clean win.

## Token refresh

Most of these CLIs refresh their own tokens by rewriting the credential file. The daemon's `cred-watcher` already watches these paths — so a refresh triggers a re-upload to Infisical automatically, with no user-visible action. The watcher debounces (5s) to avoid thrashing on rapid writes.

## Security

- Credentials at rest are stored in Infisical under `/users/{userId}/agents/{toolId}/`, matching AgentHub's existing per-user secret namespacing.
- WS traffic between server and agent daemon uses the existing per-session `AGENT_TOKEN` (already in place).
- Credential file contents are base64-encoded in transit but **never logged**. The orchestrator's logger has an explicit `redactedFields` list including `contents`.
- The auth-helper session is owned by the requesting user — no cross-user credential access.
- Audit log records `(timestamp, userId, action, toolId, sessionId)` for connect, disconnect, and refresh. Admin can review via `Admin → Audit log` (a new entry surface — see "Admin surface" below).
- Disconnect deletes the credential from Infisical and from the user's volume in one shot — no orphaned copies.

## Failure modes

| Scenario | Behaviour |
|---|---|
| Auth helper session fails to reach `active` within 60s | SSE error → modal shows "Couldn't start auth helper. Try again." Logs the underlying provisioner error for admin debugging. |
| CLI exits non-zero without printing a matching URL | After `loginTimeoutSec`, daemon kills process. Server sends the last 20 lines of stderr to the modal so the user can debug (e.g. "command not found" if the CLI isn't installed in the image). |
| User closes modal before URL is clicked | Server sends `auth.cancel`, daemon SIGTERMs `claude /login`, helper session destroyed. No credential captured. No partial state. |
| User clicks URL but never completes OAuth in their browser | CLI `claude /login` eventually times out and exits. Daemon reports failure. Modal shows "Login window closed without completing." |
| Credential file is captured but Infisical write fails | Captured file still landed in the user's volume (so the CLI works locally in their next session), but durability is broken. Server retries the Infisical write 3x with backoff; if all fail, status endpoint flags the tool as "connected (durability degraded)" with an explanatory tooltip and a "Re-sync" action button. |
| User has the CLI's API-key env var also set (e.g. `ANTHROPIC_API_KEY` from the existing Integrations card) AND OAuth credential file | The CLI's own precedence rules decide (typically credential file wins for Claude Code; API key is a fallback). Document this in the Integrations card UI ("OAuth takes precedence when both are set"). |
| User manually runs `claude /login` in their interactive terminal | The cred-watcher in that user's active session still catches the write and mirrors to Infisical → Integrations page updates automatically. This is the "power user" backdoor; the UI flow is preferred but the manual flow continues to work. |
| User runs Connect twice in two browser tabs | Each Connect spins up its own ephemeral helper. The second capture overwrites the first in Infisical (last-write-wins). No corruption, but the user sees two ✓s. Acceptable. |
| Provisioner mode = `dokploy-remote` | Identical — the agent WS protocol is the same; auth-helper sessions run on Dokploy-managed containers without code changes. |

## Edge case: tools without a clean `/login` flow

Some CLIs may not match this pattern cleanly (e.g. they require an API key only, or use a TUI prompt that doesn't print a URL). For v1, the registry only includes tools where the URL-pattern flow works. Tools that don't fit get one of:

- **API-key-only path** — falls back to the existing `infrastructure_configs` + env-var injection pattern (already shipped for `ai-anthropic` etc.). The Integrations card shows "Paste API key" instead of "Connect."
- **Out of scope for v1** — documented but not added to the registry.

## Web UI

**Integrations page** (`packages/web/src/pages/Integrations.tsx`):

A new top section **"Agent CLIs"** placed above the existing AI provider section. Each tool in the registry renders an `AgentCard`:

```
┌─────────────────────────────────────────────────────┐
│  🟢  Claude Code                                    │
│      Connected · expires in 6 days                  │
│                              [Refresh]  [Disconnect]│
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  ⚪  OpenAI Codex                                   │
│      Not connected                                  │
│                                          [Connect]  │
└─────────────────────────────────────────────────────┘
```

**AgentLoginModal** (`packages/web/src/components/agent-auth/AgentLoginModal.tsx`):

States: `preparing` → `awaiting-url` → `awaiting-click` → `awaiting-callback` → `captured` → `done`.

```
┌──────────────────────────────────────────┐
│  Connect Claude Code                     │
│                                          │
│  [spinner] Preparing secure auth helper… │
│                                          │
│                          [Cancel]        │
└──────────────────────────────────────────┘

         ↓ helper session active

┌──────────────────────────────────────────┐
│  Connect Claude Code                     │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │  Open Claude login →               │  │
│  └────────────────────────────────────┘  │
│  Opens in your browser. Sign in with     │
│  the Anthropic account you want to use.  │
│                                          │
│                          [Cancel]        │
└──────────────────────────────────────────┘

         ↓ callback captured

┌──────────────────────────────────────────┐
│  Connect Claude Code                     │
│                                          │
│  ✓ Connected                             │
│  Expires in 6 days                       │
│                                          │
└──────────────────────────────────────────┘
```

Optional: a "Show terminal output" disclosure that exposes the raw daemon stdout for users who want to see what's happening. Hidden by default.

## Admin surface

- **Audit log**: a new admin page at `/admin/audit` (or extend an existing one if present) surfaces `(timestamp, userId, action, toolId)` rows. Filterable by user and tool.
- **Tool registry visibility**: a read-only admin view of the active tool registry, useful for confirming which CLIs are supported in the current build.

## File layout

```
packages/server/src/services/agent-auth/
├── registry.ts                  # static AgentTool[] + helpers
├── orchestrator.ts              # connect/disconnect/refresh state machines
├── credential-sync.ts           # hydrate-on-session-active
├── infisical-paths.ts           # /users/{uid}/agents/{tool}/...
└── __fixtures__/
    └── cli-stdout-samples/      # snapshot fixtures for urlPattern tests

packages/server/src/routes/
└── integrations-agents.ts       # GET /, POST /:id/connect (SSE), POST /:id/disconnect, POST /:id/refresh

packages/server/src/services/session-manager.ts
   # add: post-active hook calls credentialSync.hydrate(session)
   # add: ephemeral auth-helper session lifecycle (purpose: "agent-auth")

packages/agent/src/auth/
├── handler.ts                   # WS message handlers: auth.connect, auth.disconnect, auth.hydrate, auth.cancel
└── cred-watcher.ts              # fs.watch + debounce + ship-to-server

packages/agent/src/index.ts
   # wire up handler + cred-watcher on daemon start

packages/web/src/pages/
└── Integrations.tsx             # new "Agent CLIs" section

packages/web/src/components/agent-auth/
├── AgentCard.tsx                # one card per tool, status/actions
├── AgentLoginModal.tsx          # SSE-streamed modal with state machine
└── useAgentStatus.ts            # poll/subscribe hook
```

## Database

No schema changes. All credentials live in Infisical; audit log uses the existing audit table if present, else adds one in a separate migration.

If an audit table doesn't exist, add:

```sql
CREATE TABLE agent_auth_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,                   -- epoch ms
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,                  -- "connect" | "disconnect" | "refresh" | "hydrate" | "capture"
  tool_id TEXT NOT NULL,
  session_id TEXT,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT
);
CREATE INDEX agent_auth_audit_user ON agent_auth_audit(user_id, ts DESC);
```

## API

| Method & path                                       | Purpose                                          | Auth     |
|-----------------------------------------------------|--------------------------------------------------|----------|
| `GET  /api/integrations/agents`                     | List all tools + per-user status                 | user     |
| `POST /api/integrations/agents/:toolId/connect`     | Start connect flow (SSE-streamed)                | user     |
| `POST /api/integrations/agents/:toolId/disconnect`  | Tear down credentials                            | user     |
| `POST /api/integrations/agents/:toolId/refresh`     | Re-run login flow (same as connect, just labelled differently in the UI for already-connected tools) | user     |
| `GET  /api/admin/agent-auth/audit`                  | Audit log (filterable by user_id, tool_id)       | admin    |
| `GET  /api/admin/agent-auth/registry`               | Read-only registry view                          | admin    |

SSE event format for the connect endpoint:

```
event: state
data: {"phase":"preparing"}

event: state
data: {"phase":"awaiting-url"}

event: url
data: {"url":"https://claude.ai/oauth/authorize?..."}

event: state
data: {"phase":"awaiting-callback"}

event: captured
data: {"toolId":"claude-code","expiresAt":"2026-05-20T00:00:00Z"}

event: done
data: {"ok":true}
```

Errors emit `event: error` with `{message, detail?}` and close the stream.

## Testing strategy

### Unit (vitest)

- `registry.test.ts`: registry validation (no duplicate IDs, all paths absolute or `~`-prefixed, urlPatterns are valid regexes).
- `url-pattern.test.ts`: each tool's `urlPattern` matches its fixture stdout sample and does NOT match decoy strings.
- `infisical-paths.test.ts`: path construction is deterministic, escaped properly.
- `credential-sync.test.ts`: hydration decision logic is idempotent (file present → no-op, file absent + Infisical has it → write, file absent + Infisical empty → no-op).
- `orchestrator.test.ts`: state machine transitions, cancel-during-each-phase, timeout enforcement.

### Integration (vitest, in `packages/server`)

- Fake "CLI" binary at `packages/server/test/fixtures/fake-claude` that prints a known URL and writes a known credential file. Mocks the agent WS. Exercises the full connect roundtrip end-to-end against the orchestrator.
- Same for disconnect and refresh.
- Hydration test: pre-populate Infisical, spin up a mock daemon, verify the file lands at the right path with the right perms.

### E2E

Extend `scripts/e2e-full.js` with a test that:

1. Registers a `test-tool` in the registry (test-only build flag).
2. Wires the fake CLI binary into the workspace image (test image variant).
3. Drives the full Connect → Disconnect → Connect cycle from the API.
4. Verifies credential roundtrip through Infisical.

Real Claude/Codex/GitHub OAuth flows require live external accounts and are **manual verification only**, run on VM 925 as part of release checks. Documented in `docs/operations/agent-auth-verification.md` (to be created during implementation).

## Migration / rollout

- No data migration required (all-new tables and Infisical paths).
- The new "Agent CLIs" section appears on the Integrations page as soon as the feature ships. Existing users see all tools as "Not connected" until they click Connect on each.
- Users with existing API keys configured under `ai-anthropic` / `ai-openai` are unaffected — those keep working. The new OAuth path adds capability; nothing is removed.

## Open questions

None blocking. To resolve during implementation:

- Whether the "Show terminal output" disclosure ships in v1 or is deferred — recommend ship-in-v1 for debuggability.
- Whether the audit log gets its own admin page in v1 or piggy-backs on an existing audit surface if one is added concurrently — defer to whoever picks up the plan to decide based on what exists at that moment.

## What this design explicitly rejects

- **Server-mediated OAuth (Option B from the brainstorm).** Reverse-engineering each CLI's OAuth client to do the dance server-side. Rejected because: brittle to upstream changes, doesn't generalize beyond a handful of tools, possibly violates ToS for impersonating a CLI's client. The chosen design uses each CLI's own login command — if it works on a laptop, it works here.
- **Reusing the user's active session for the auth helper.** Rejected because: stale in-memory `claude` processes wouldn't pick up new credentials (the user would see ✓ in the UI but still be unauthorized in their open terminal), watcher noise from unrelated user activity could trigger false captures, and env contamination could change CLI behaviour. Always-ephemeral is worth the 5-15s.
- **Multi-account-per-tool.** YAGNI for v1. Disconnect + reconnect to switch accounts.
- **Encryption of stored credentials beyond what Infisical provides.** Infisical is already AgentHub's secret store of record; adding another encryption layer adds complexity without changing the threat model.
- **Warp.** Warp is a local-machine terminal application; its agent features run on the user's desktop, not inside a containerized CLI. There is no headless `warp` agent that runs inside a ttyd/SSH session. AgentHub is not in Warp's auth loop. Users who want Warp can SSH from their local Warp app into an AgentHub workspace, but that's outside this design.
- **Superset (`superset.sh`).** Superset is itself a desktop IDE / CLI that orchestrates other coding agents (Claude Code, Cursor, OpenCode, etc.) on the user's local machine. It's a *peer* to AgentHub, not a CLI that runs inside an AgentHub workspace. There's no integration model that makes sense — anything Superset would auth to, AgentHub already auths to directly via this design.
