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
# shells.

set -eu

REAL_GH="/usr/bin/gh"

# Respect explicit user overrides — if GH_TOKEN or GITHUB_TOKEN is already
# set, don't clobber it. Gives the user the escape hatch of
# `GH_TOKEN=ghp_... gh foo` for ad-hoc PAT usage.
if [ -n "${GH_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ]; then
  exec "$REAL_GH" "$@"
fi

# Delegate the env-loading + curl + jq extraction to the shared mint script
# so this wrapper stays in sync with the git credential helper. Non-zero
# rc means "no token available" (creds missing, server down, install not
# configured) — pass through to real gh, which will produce its own
# "not authenticated" error.
token="$(/opt/agenthub-agent/agenthub-mint-github-token 2>/dev/null || true)"
if [ -n "$token" ]; then
  export GH_TOKEN="$token"
fi

exec "$REAL_GH" "$@"
