# Agent CLI Auth — Manual Verification

Live OAuth flows require real Anthropic, OpenAI, and GitHub accounts; this checklist is run on a fresh VM with the install completed and you logged in as a regular user. Automated e2e (`scripts/e2e-full.js`) covers route mounting; this doc covers the full UX end-to-end.

## Setup

1. Install AgentHub on a fresh VM (`./scripts/install.sh`).
2. Log in as a regular (non-admin) user.
3. **Install non-built-in CLIs first.** Claude Code and GitHub CLI are baked into the workspace image; **Codex must be installed via the Packages page** (`Packages → OpenAI Codex → Install`) before you can Connect. If you try to Connect before installing, you'll see *"'codex' is not installed in this workspace — install it from the Packages page first."*
4. Navigate to **Integrations** in the sidebar.

You should see an **Agent CLIs** section at the top with three cards:

- Claude Code · Not connected
- OpenAI Codex · Not connected
- GitHub CLI · Not connected

## Claude Code

1. Click **Connect** on the Claude Code card.
2. Modal opens with the spinner: *"Preparing secure auth helper…"*. After ~5–15s an ephemeral workspace boots.
3. A large blue **Open Claude Code login →** button appears. Click it.
4. New browser tab opens to `claude.ai/oauth/authorize?...`. Sign in with the Anthropic account you want this workspace to use.
5. Return to the AgentHub tab. Modal flips to *"Credentials captured. Finalising…"* then *"✓ Connected"* and auto-closes after ~1.5s.
6. The card now shows: *"Connected · expires {date}"* (parsed from the credential's `expiresAt`).
7. Open a **new** regular session. In the terminal, run `claude --version` and then a short prompt. Confirm it does NOT prompt for login — credentials were hydrated from Infisical at session start.
8. Click **Disconnect**. Card returns to *"Not connected"*. Confirm `~/.claude/.credentials.json` is gone from the workspace (`ls /home/coder/.claude/`).

## OpenAI Codex

Repeat the same flow with the Codex card. The OAuth tab goes to `auth.openai.com`. Sign in with the ChatGPT account.

After **✓ Connected**:

- New session, terminal: `codex --version`. Should NOT prompt for login.
- Disconnect, verify `~/.codex/auth.json` is gone.

## GitHub CLI

Repeat with the GitHub CLI card. The OAuth flow uses GitHub's device-code page.

After **✓ Connected**:

- New session, terminal: `gh auth status`. Should report you as signed in.
- Disconnect, verify `~/.config/gh/hosts.yml` is gone.

## Cross-volume durability check

Tests that Infisical mirror survives volume loss.

1. Connect Claude Code (see above).
2. As admin, on the host VM: `docker volume rm agenthub-home-<userId>` (replace `<userId>` with the SQLite users.id of the test user — look it up via `sqlite3 /data/agenthub.db "SELECT id, username FROM users;"`).
3. Start a new session for that user. Open the terminal.
4. Confirm `cat ~/.claude/.credentials.json` shows the original credentials — hydrated from Infisical even though the volume was destroyed.

## Audit log

As admin:

1. Navigate to **Admin → Agent CLI Audit**.
2. Paste the test user's ID and press Enter (or wait for the auto-fetch).
3. Confirm rows appear for each `connect`, `capture`, and `disconnect` event you exercised above. The `tool_id` and `ok=ok` columns should match what happened.

## Known limitations

- Auth-helper sessions take 5–15s cold-start; pre-warm is intentionally not implemented (see spec, "Auth-helper session lifecycle").
- Hydration is best-effort; failures are logged but non-fatal — the user just sees the CLI's own auth prompt on first invocation, same as before this feature existed.
- Tokens refresh automatically via the in-workspace credential watcher — a token rotation by `claude` or `codex` re-fires `auth.captured` and re-mirrors to Infisical with no user-visible action.
