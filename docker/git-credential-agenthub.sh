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

# Delegates env loading + curl + jq extraction to the shared mint script
# so the gh wrapper stays behaviorally in sync. Non-zero rc means "no
# token available" (creds missing, server down, install not configured)
# — exit 0 silently so git falls back to its normal prompt/fail path.
token="$(/opt/agenthub-agent/agenthub-mint-github-token 2>/dev/null)" || exit 0
[ -n "$token" ] || exit 0

printf 'username=x-access-token\npassword=%s\n' "$token"
