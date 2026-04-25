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
  claude --model MiniMax-M2.7 --dangerously-skip-permissions "$@"
