#!/bin/sh
# git-credential-agenthub — git credential helper that fetches a short-lived
# GitHub App installation token from the AgentHub server per-operation.
#
# Why: the alternative is baking the token into ~/.gitconfig URL-rewrite rules
# (Vercel/Codespaces pattern), which leaks the token into workspace backups
# and inherited process envs. This helper keeps the token on the server and
# only materializes it for the ~100ms git needs to complete auth.
#
# Invoked by git with action "get" on stdin protocol; anything else is a
# silent no-op so git falls back to its default (prompting the user).
#
# Environment:
#   AGENT_TOKEN  — per-session secret set by SessionManager, used to auth
#                  the HTTP call back to the server's agent-scoped routes.
#   PORTAL_URL   — server's internal URL from the workspace's POV. Set by
#                  SessionManager at provision time.
#
# Reads those from ~/.agenthub-env written by the agent entrypoint (which
# also is where other shells source session env), so this helper works from
# any shell regardless of whether the user sourced the env themselves.

set -eu

[ "${1:-}" = "get" ] || exit 0

# Parse git's key=value stdin until a blank line. We only care about `host`
# to decide whether we handle this request — anything else (gitlab etc.)
# should exit silently so git picks another helper.
host=""
while IFS= read -r line; do
  [ -z "$line" ] && break
  case "$line" in
    host=*) host="${line#host=}" ;;
  esac
done

[ "$host" = "github.com" ] || exit 0

# Source session env. Harmless if the file is missing — we'll bail on the
# empty-var check below.
if [ -r "$HOME/.agenthub-env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.agenthub-env"
fi

[ -n "${AGENT_TOKEN:-}" ] || exit 0
[ -n "${PORTAL_URL:-}" ] || exit 0

# 5s timeout keeps a dead server from hanging interactive git commands;
# jq is available in the workspace image (already installed for other
# tooling). --fail-with-body lets us differentiate network errors from
# HTTP 4xx/5xx — both end up exiting silently, which triggers git's
# default auth behavior (prompt or fail).
resp="$(curl -sS --max-time 5 \
  -H "Authorization: AgentToken ${AGENT_TOKEN}" \
  "${PORTAL_URL%/}/api/agent/github/token" 2>/dev/null || true)"

[ -n "$resp" ] || exit 0

token="$(printf '%s' "$resp" | jq -r '.token // empty' 2>/dev/null || true)"
[ -n "$token" ] || exit 0

printf 'username=x-access-token\npassword=%s\n' "$token"
