#!/bin/sh
# gh wrapper — mint a short-lived GitHub App installation token per-invocation
# and expose it to `gh` via GH_TOKEN, so `gh auth status` reports
# authenticated out of the box and agents don't insist the user run
# `gh auth login`.
#
# Parallel to docker/git-credential-agenthub.sh, which handles the git-command
# case via the credential-helper protocol. `gh` uses its own auth discovery
# (GH_TOKEN / GITHUB_TOKEN / ~/.config/gh/hosts.yml) and ignores git credential
# helpers, so we bridge it here.
#
# Same security posture as the git helper: the token exists only for the
# lifetime of THIS gh subprocess. Not written to disk. Not exposed to sibling
# shells. `unset GH_TOKEN` afterwards isn't needed because the export is
# inherited only by the exec'd process, which is about to terminate.
#
# Environment (inherited from the container):
#   AGENT_TOKEN  — per-session bearer
#   PORTAL_URL   — AgentHub server URL from the workspace's POV
#
# Falls back silently to the real `gh` if either is missing, so a user who
# hasn't installed the GitHub App (or is running gh before the daemon has
# populated env) still gets normal gh behavior (prompting for login).

set -eu

REAL_GH="/usr/bin/gh"

# Respect explicit user overrides — if GH_TOKEN or GITHUB_TOKEN is already
# set, don't clobber it. Gives the user the escape hatch of
# `GH_TOKEN=ghp_... gh foo` for ad-hoc PAT usage.
if [ -n "${GH_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ]; then
  exec "$REAL_GH" "$@"
fi

# Source session env as belt-and-suspenders — matches the git helper's
# behavior for shells that don't inherit the container env (sudo resets
# env by default, etc).
if [ -r "$HOME/.agenthub-env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.agenthub-env"
fi

# No creds available → run real gh unchanged. Agents that hit this path
# (no App installed for this user) still see "not logged in" — but that's
# accurate rather than misleading.
if [ -z "${AGENT_TOKEN:-}" ] || [ -z "${PORTAL_URL:-}" ]; then
  exec "$REAL_GH" "$@"
fi

# 5s timeout keeps a dead server from hanging gh invocations. Failures
# here (network, 401, expired install) drop through to un-authenticated
# gh so the user gets gh's normal error instead of a wrapper error.
resp="$(curl -sS --max-time 5 \
  -H "Authorization: AgentToken ${AGENT_TOKEN}" \
  "${PORTAL_URL%/}/api/agent/github/token" 2>/dev/null || true)"

if [ -n "$resp" ]; then
  token="$(printf '%s' "$resp" | jq -r '.token // empty' 2>/dev/null || true)"
  if [ -n "$token" ]; then
    export GH_TOKEN="$token"
  fi
fi

exec "$REAL_GH" "$@"
