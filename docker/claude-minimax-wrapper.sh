#!/bin/bash
#
# claude-minimax — Claude Code's UX, MiniMax's model.
#
# Routes the official `claude` CLI through MiniMax's Anthropic-compatible
# endpoint by overriding ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN for
# this one process. The MINIMAX_API_KEY env var is injected by the
# AgentHub server when a session starts, sourced from the user's
# Integrations → AI Providers → MiniMax row.
#
# Without a key we fail fast with an actionable message — calling
# `claude` blind would hit Anthropic with a model name Anthropic
# doesn't know and surface a confusing "model not found" error.
set -euo pipefail

if [[ -z "${MINIMAX_API_KEY:-}" ]]; then
  cat >&2 <<'EOF'
claude-minimax: MINIMAX_API_KEY is not set.

Add a MiniMax API key in AgentHub:
  Integrations → Add → MiniMax → paste apiKey → Save

Then start a NEW session — env vars are injected at session create
time, so existing sessions don't pick up newly-saved keys.
EOF
  exit 1
fi

# Resolve the claude binary. Prefer the per-user install (~/.local/bin)
# because the workspace image no longer bakes claude in; fall back to PATH
# for installs that still have a system-wide one (during rolling upgrades).
CLAUDE_BIN="${HOME}/.local/bin/claude"
if [ ! -x "$CLAUDE_BIN" ]; then
  CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
fi
if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
  cat >&2 <<'EOF'
claude-minimax: Claude Code is not installed in this workspace yet.

Wait a few seconds for the essentials installer to finish (terminal
scrollback will show "[essentials] claude-code installed"), or open the
Packages page and install Claude Code manually.
EOF
  exit 1
fi

exec env \
  ANTHROPIC_BASE_URL="${MINIMAX_BASE_URL:-https://api.minimax.io/anthropic}" \
  ANTHROPIC_AUTH_TOKEN="$MINIMAX_API_KEY" \
  ANTHROPIC_MODEL="MiniMax-M2.7" \
  ANTHROPIC_DEFAULT_SONNET_MODEL="MiniMax-M2.7" \
  ANTHROPIC_DEFAULT_OPUS_MODEL="MiniMax-M2.7" \
  ANTHROPIC_DEFAULT_HAIKU_MODEL="MiniMax-M2.7" \
  ANTHROPIC_SMALL_FAST_MODEL="MiniMax-M2.7" \
  API_TIMEOUT_MS=3000000 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  "$CLAUDE_BIN" --model MiniMax-M2.7 --dangerously-skip-permissions "$@"
