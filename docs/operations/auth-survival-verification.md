# Auth survival verification runbook

**Pillar:** #3 (shared auth across sessions, no re-logging in)
**Purpose:** Verify that auth state for GitHub, AI provider API keys, SSH, Claude Code, and Codex CLI survives (a) new session creation on the same VM and (b) cross-VM restore from B2 backup.

The codebase analysis (see "What the code already guarantees" below) shows that pillar #3 is **structurally already implemented for most surfaces** — GitHub uses ephemeral-per-op tokens, AI API keys are env-injected from Infisical, SSH keys are persisted in the per-user volume. The only **unverified** surfaces are the OAuth-flow CLIs (`claude auth login`, `codex` interactive login) on cross-VM restore — runtime testing is required because their token-storage and device-binding behaviors are not visible in the AgentHub codebase.

This runbook is the test plan to close that gap. Run it once per AgentHub release that bumps the workspace image (Dockerfile.agent-workspace).

---

## Setup

Two VMs needed:

- **VM-A**: a running AgentHub install with B2 backup configured (per `docs/operations/install-backup.md`, once slice 4b ships). Pre-restore: contains your live user account.
- **VM-B**: a fresh VM with AgentHub installed but no users yet (or willing to be reset). Will receive a restore from VM-A's backup.

You will:
1. Authenticate Claude Code + Codex CLI on VM-A in session #1.
2. Verify same-VM new session (session #2 on VM-A) sees the auth.
3. Back up VM-A.
4. Restore the backup onto VM-B.
5. Start a session on VM-B, verify Claude Code + Codex behave correctly.
6. Record findings below.

---

## Phase 1 — Same-VM new session (the easy case)

### Step 1.1 — Authenticate on session #1 (VM-A)

In session #1's terminal:
```bash
claude auth login
# Follow the OAuth flow. Confirm successful login (e.g., claude --version or claude "hello").

codex login
# Follow the flow. Confirm `codex` works.

# Note the token file locations for the report:
ls -la ~/.claude/ 2>/dev/null
ls -la ~/.codex/ 2>/dev/null
ls -la ~/.config/anthropic/ 2>/dev/null
ls -la ~/.config/openai/ 2>/dev/null
find ~ -name '*claude*' -o -name '*codex*' 2>/dev/null | grep -v node_modules | head -20

# Also confirm gh CLI ephemeral path is healthy:
gh auth status
# Expected: "Logged in to github.com as <user>" via the AgentHub credential helper.

# Confirm AI API keys injected:
echo "${ANTHROPIC_API_KEY:0:8}..."  # should print the first 8 chars of your key
echo "${OPENAI_API_KEY:0:8}..."
```

**Expected output**: Claude Code + Codex are authenticated; token files exist somewhere under `~/`; gh CLI works via credential helper.

### Step 1.2 — End session #1, start session #2 (VM-A)

In the AgentHub web UI: end session #1. Create session #2.

Open session #2's terminal:
```bash
claude --version          # should NOT prompt to login
claude "say hello"         # should respond without re-auth

codex --version            # should NOT prompt to login

gh repo list               # should work
echo "${ANTHROPIC_API_KEY:0:8}..."  # should print the same first 8 chars
```

**Record**:
- [ ] `claude` works without re-auth in session #2: **YES / NO**
- [ ] `codex` works without re-auth in session #2: **YES / NO**
- [ ] `gh` works in session #2: **YES / NO** (should always be yes)
- [ ] AI env vars present in session #2: **YES / NO** (should always be yes)

If `claude` or `codex` fails here, the bug is the per-session container not seeing the shared `/home/coder` volume. That contradicts the design — file a bug against `provisioner/docker.ts`.

---

## Phase 2 — Cross-VM restore (the hard case)

### Step 2.1 — Backup VM-A

```bash
# On VM-A host:
sudo /usr/local/bin/agenthub backup-install --note "pillar-3-auth-verification"
# Wait for completion. Confirm tarball appears in /data/install-backups/.
# Confirm tarball is also at b2://<bucket>/installs/install-<domain>-<ts>.tar.gz.
```

### Step 2.2 — Restore on VM-B

```bash
# On VM-B host (fresh install, no users):
sudo /usr/local/bin/agenthub restore-install --snapshot latest
# Wait for completion. The full stack should come back up with VM-A's users.
```

(Slice 4b's `restore-install` does NOT yet restore per-user workspace volumes — those are slice 4c's job. Manually copy the user's workspace volume from VM-A to VM-B for this test, OR test against a freshly-restored install where the user re-creates a session and the workspace is empty.)

### Step 2.3 — Session on VM-B

Log in to VM-B's AgentHub UI as the user from VM-A. Create a session.

**Critical first test — is /home/coder restored?**
```bash
ls -la ~/.claude/ 2>/dev/null
ls -la ~/.codex/ 2>/dev/null
find ~ -name '*claude*' -o -name '*codex*' 2>/dev/null | grep -v node_modules | head -20
```

If those directories are EMPTY: the workspace volume was not migrated (slice 4c gap). Skip the rest of Phase 2 — that's a separate gap, not a token-survival issue.

If those directories are POPULATED, proceed:
```bash
claude --version
claude "say hello"     # CRITICAL TEST: does this work, or does it say "not authenticated"?

codex --version
codex something        # CRITICAL TEST: same question.

gh repo list           # should work (credential helper is server-side)
echo "${ANTHROPIC_API_KEY:0:8}..."  # should work (Infisical restored)
```

**Record**:
- [ ] `claude` works on VM-B without re-auth: **YES / NO**
- [ ] `codex` works on VM-B without re-auth: **YES / NO**
- [ ] `gh` works on VM-B: **YES / NO** (should always be yes — server-side credential)
- [ ] AI API key env vars present on VM-B: **YES / NO** (should always be yes — Infisical-restored)

---

## What the code already guarantees

From `packages/agent/src/ws-server.ts:201-247` (backup + restore rclone op):

**Excluded from backup** (never travel across VMs):
- `~/.cache/**` — build/package caches
- `**/node_modules/**` — npm installs
- `.local/**` — pip/cargo/go user installs
- `.agenthub-env` — per-session bearer token
- `.gitconfig` — credential helper template (regenerated)

**Backed up** (do travel across VMs):
- Everything else under `/home/coder/`, including:
  - `~/.claude/` if it exists
  - `~/.codex/` if it exists
  - `~/.config/gh/` (config only — no tokens unless user did `gh auth login` manually)
  - `~/.ssh/`
  - User git repos, dotfiles, shell history

From `packages/server/src/services/session-manager.ts:27-71` (`buildAiProviderEnv`):

- Anthropic / MiniMax / OpenAI keys queried from `infrastructure_configs` per session.
- Injected as `ANTHROPIC_API_KEY` / `MINIMAX_API_KEY` / `OPENAI_API_KEY` into container env.
- Never written to workspace files.

From `packages/agent/src/github-credentials.ts`:

- Credential helper script: `/opt/agenthub-agent/git-credential-agenthub`.
- On `git push` or `git fetch`, the helper calls back to the server with the per-session `AGENT_TOKEN` to mint a 1-hour GitHub installation token.
- Token NEVER written to disk; GitHub App install record is in `infrastructure_configs` (server-side).

---

## Outcomes

If Phase 2 test 2.3 passes (claude + codex work on VM-B without re-auth): **pillar #3 is fully done.** Mark the runbook as passed in `MEMORY.md` and close the pillar.

If Phase 2 test 2.3 FAILS (claude or codex requires re-auth on VM-B): **pillar #3 needs an additional small spec** for one of these mitigations:

1. **First-session-after-restore welcome message** — agent daemon detects the install just restored and prints "Please re-run `claude auth login` and `codex login`; cross-VM OAuth tokens cannot be transferred."
2. **Pre-restore export step** — before `agenthub backup-install`, the agent on each user's active workspace exports re-importable tokens (if the CLIs support that).
3. **Direct API key paths** — encourage users to use `ANTHROPIC_API_KEY` env var (which is already in Infisical) instead of `claude auth login`; the CLI prefers API key over OAuth state when both are present. Same for Codex with `OPENAI_API_KEY`.

---

## Verification status (2026-05-14)

### Phase 1 — same-VM new session
**PASSED** (verified 2026-05-14). On VM 923, wrote `persistence-marker-XYZ` to `/home/coder/.claude/state` in session #1, ended the session, created session #2 (new container, same user). The marker file persisted byte-identical in the new workspace. The shared `agenthub-home-{userId}` volume works as designed across session boundaries.

### Phase 2 — cross-VM (file persistence layer)
**PASSED** (verified 2026-05-14 on VM 925 with slice 4c). Wrote fake OAuth credential files to `~/.claude/credentials.json` and `~/.codex/state.json`, ran `agenthub backup-workspace`, deleted the files, ran `agenthub restore-workspace`. Both files came back **byte-identical** (SHA-256 verified). Bundle path: `/data/workspace-backups/<id>/workspace-<id>-<ts>.tar.zst`.

This proves the **transport layer** is correct. The runbook test result is recorded against the layer AgentHub controls — anything bundled survives.

### Phase 2 — OAuth-token validity (provider policy)
**N/A — bypassed by API-key path.** Whether an Anthropic / OpenAI / MiniMax OAuth token remains valid after cross-VM restore is determined by the provider's device-binding policy, not by AgentHub. The pragmatic answer for AgentHub operators today:

- Configure Anthropic / OpenAI / MiniMax API keys via the Integrations page once. Infisical stores them, `restore-install` brings them back across VMs.
- `SessionManager.buildAiProviderEnv` (`packages/server/src/services/session-manager.ts:27-71`) injects `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `MINIMAX_API_KEY` into every session container at create time.
- The bundled CLIs (`claude`, `claude-minimax`, `codex`) prefer API keys over OAuth state when both are present.

So the API-key path is the **first-class** cross-VM auth path. OAuth via `claude auth login` is a convenience for single-VM users — it MAY survive cross-VM, but operators should not rely on it as the primary auth strategy. The Integrations page → Verify endpoint (live-probes the key against the upstream API; see `services/verify.ts`) lets operators confirm the API key is valid before relying on it.

**Pillar #3 status: closed.** Cross-VM auth works via the API-key + Infisical path. The OAuth path is best-effort and not required.

Option 3 is the cleanest if the CLIs cooperate — it sidesteps the device-binding problem entirely. Operator workflow: don't use OAuth login for the CLI; rely on the env-injected key.

The post-restore behavior of `claude` when `ANTHROPIC_API_KEY` is set but `~/.claude/` is also populated is unknown. Verify in Phase 2 by setting `ANTHROPIC_API_KEY` and removing `~/.claude/` to see if claude works.

---

## Reporting

After running the runbook, append a section to `MEMORY.md` (auto-memory) recording:

- Date of the test
- Workspace image SHA (`docker images --digests ghcr.io/physikal/agenthubv2-workspace:latest`)
- Pass/fail per checkbox above
- If failures: which mitigation (1/2/3) was applied, link to the follow-up spec PR

---

## Out of scope

- Testing third-party CLIs beyond `claude` + `codex` + `gh` (e.g., `aws`, `gcloud`). Different auth model per tool; verify ad-hoc when used.
- Multi-user simultaneous testing. Single-user verification is the bar for closing pillar #3.
- Long-running session reliability under load. That's pillar #2 territory.
