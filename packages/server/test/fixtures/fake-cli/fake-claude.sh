#!/bin/sh
set -eu
echo "Open this URL in your browser:"
echo "https://claude.ai/oauth/authorize?fake=1&state=test"
sleep 0.2
mkdir -p "$HOME/.claude"
echo '{"token":"fake-token","expiresAt":'"$(($(date +%s) * 1000 + 86400000))"'}' > "$HOME/.claude/.credentials.json"
