#!/bin/bash
#
# Entrypoint for the AgentHub workspace container.
#
# Starts two processes:
#   1. ttyd (as `coder`, port 7681) — terminal WebSocket server
#   2. agent daemon (as root, port 9876, PID 1) — control channel back to
#      the AgentHub server. Runs last + in foreground so a crash here kills
#      the container and the driver can restart it.
#
# Environment (injected by SessionManager → driver.create):
#   AGENT_TOKEN  — bearer the agent sends back to the server
#   AGENT_PORT   — defaults to 9876
#   PORTAL_URL   — base URL of the AgentHub server
#   SESSION_ID   — exposed to shells as AGENTHUB_SESSION_ID
#   AGENTHUB_PUBLIC_URL (optional) — exposed to shells as AGENTHUB_URL for
#     the `preview` helper.

set -euo pipefail

AGENT_PORT="${AGENT_PORT:-9876}"
TTYD_PORT="${TTYD_PORT:-7681}"

# Fresh volume? /home/coder will be root-owned on first boot — fix it so the
# coder user can write. This is safe on subsequent boots because chown -R on
# an already-correct tree is a no-op.
chown -R coder:coder /home/coder

# Expose session metadata to the interactive shell via ~coder/.agenthub-env
# — profile.d sources this on login. AGENT_TOKEN + PORTAL_URL are included
# so the git credential helper AND the `gh` wrapper can find them even in
# shells where sudo -u coder stripped them from the inherited env. The
# file is mode 600 because it carries the per-session bearer — that token
# is scoped to this container and only useful from inside it, so leaking
# it within the container to another user doesn't matter (there is no
# other real user), but 600 is still the right default.
cat > /home/coder/.agenthub-env <<EOF
export AGENTHUB_SESSION_ID="${SESSION_ID:-}"
export AGENTHUB_SESSION_NAME="${SESSION_NAME:-}"
export AGENTHUB_URL="${AGENTHUB_PUBLIC_URL:-${PORTAL_URL:-}}"
export AGENT_TOKEN="${AGENT_TOKEN:-}"
export PORTAL_URL="${PORTAL_URL:-}"
EOF
chown coder:coder /home/coder/.agenthub-env
chmod 600 /home/coder/.agenthub-env

cat > /etc/profile.d/agenthub-env.sh <<'EOF'
[ -f /home/coder/.agenthub-env ] && . /home/coder/.agenthub-env
EOF

# Start ttyd as coder with dtach for session persistence. `-W` enables write
# access (ttyd defaults to read-only). The -t options allow titleChange and
# disable ttyd's reconnect timeout.
#
# The subshell `cd /home/coder` makes the terminal open in the user's
# workspace root instead of `/` (the entrypoint's default cwd). cwd is
# latched into the dtach-spawned bash at session creation, so reattaches
# keep whatever directory the user cd'd to. Parent shell's cwd is not
# touched, so the agent daemon below still execs from the original cwd.
( cd /home/coder && exec sudo -u coder /usr/local/bin/ttyd \
  -W \
  -p "${TTYD_PORT}" \
  -t 'titleFixed=AgentHub' \
  -t 'disableReconnect=false' \
  /usr/bin/dtach -A /tmp/agenthub.dtach -r none bash -l ) \
  > /var/log/ttyd.log 2>&1 &
TTYD_PID=$!

# Reap ttyd if it dies so we don't leak a zombie; exit the container so
# Docker restarts it fresh.
trap 'kill -TERM "$TTYD_PID" 2>/dev/null || true' TERM INT

# Agent daemon runs in foreground as PID 1 so Docker's restart policy applies.
exec /usr/bin/node /opt/agenthub-agent/index.js
