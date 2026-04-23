#!/bin/sh
# agenthub-mint-github-token — fetch a short-lived GitHub App installation
# token from the AgentHub server and print it to stdout. Exits non-zero
# (with nothing on stdout) if creds aren't configured, the server is
# unreachable, or the response doesn't contain a token.
#
# Shared by:
#   - /opt/agenthub-agent/git-credential-agenthub  (git credential helper)
#   - /usr/local/bin/gh                            (gh wrapper)
#
# Keeping one source means a change to the token endpoint, error
# handling, or env-loading is a one-file edit. Callers MUST check the
# exit code; treat non-zero as "no token available" and fall back to
# whatever unauthenticated behavior makes sense in their context.
#
# Environment (read from inherited env, with ~/.agenthub-env as fallback
# for shells that lost env inheritance across sudo -u coder etc):
#   AGENT_TOKEN  — per-session bearer the agent daemon was started with
#   PORTAL_URL   — AgentHub server's URL from the workspace's POV

set -eu

if [ -r "$HOME/.agenthub-env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.agenthub-env"
fi

[ -n "${AGENT_TOKEN:-}" ] || exit 1
[ -n "${PORTAL_URL:-}" ] || exit 1

# 5s timeout keeps a dead server from hanging the caller. --fail-with-body
# would let us differentiate network vs 4xx/5xx, but both end up as
# "no token" anyway, so plain silent-on-error is fine here. Caller
# exits cleanly (non-zero rc) and whatever downstream behavior picks up
# from there.
resp="$(curl -sS --max-time 5 \
  -H "Authorization: AgentToken ${AGENT_TOKEN}" \
  "${PORTAL_URL%/}/api/agent/github/token" 2>/dev/null || true)"

[ -n "$resp" ] || exit 1

token="$(printf '%s' "$resp" | jq -r '.token // empty' 2>/dev/null || true)"
[ -n "$token" ] || exit 1

printf '%s' "$token"
