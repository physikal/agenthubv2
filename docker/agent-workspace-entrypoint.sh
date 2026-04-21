#!/bin/bash
#
# Entrypoint for the AgentHub v2 workspace container.
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
# — profile.d sources this on login.
cat > /home/coder/.agenthub-env <<EOF
export AGENTHUB_SESSION_ID="${SESSION_ID:-}"
export AGENTHUB_SESSION_NAME="${SESSION_NAME:-}"
export AGENTHUB_URL="${AGENTHUB_PUBLIC_URL:-${PORTAL_URL:-}}"
EOF
chown coder:coder /home/coder/.agenthub-env

cat > /etc/profile.d/agenthub-env.sh <<'EOF'
[ -f /home/coder/.agenthub-env ] && . /home/coder/.agenthub-env
EOF

# Start ttyd as coder with dtach for session persistence. `-W` enables write
# access (ttyd defaults to read-only). The -t cmd options match v1's LXC
# template: allow titleChange, no reconnect timeout.
sudo -u coder /usr/local/bin/ttyd \
  -W \
  -p "${TTYD_PORT}" \
  -t 'titleFixed=AgentHub' \
  -t 'disableReconnect=false' \
  /usr/bin/dtach -A /tmp/agenthub.dtach -r none bash -l \
  > /var/log/ttyd.log 2>&1 &
TTYD_PID=$!

# Reap ttyd if it dies so we don't leak a zombie; exit the container so
# Docker restarts it fresh.
trap 'kill -TERM "$TTYD_PID" 2>/dev/null || true' TERM INT

# Agent daemon runs in foreground as PID 1 so Docker's restart policy applies.
exec /usr/bin/node /opt/agenthub-agent/index.js
