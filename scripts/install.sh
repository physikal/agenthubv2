#!/usr/bin/env bash
#
# AgentHub v2 install script.
#
# Wraps three steps behind one command so the README can say "clone + run":
#   1. pnpm install the installer package
#   2. docker build both images locally (server + workspace) unless the caller
#      pins prebuilt tags via AGENTHUB_SERVER_IMAGE and AGENTHUB_WORKSPACE_IMAGE
#   3. Runs the installer — TUI by default, `--non-interactive` passes through
#      to the Node process and consumes env vars instead.
#
# Exit codes: same as the installer (0=ok, 2=missing required env var,
# 3=install failure). Prereq failures surface as 1.

set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found. Install it:" >&2
  echo "  sudo corepack enable && corepack prepare pnpm@10.12.1 --activate" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found. See docs/install/humans.md for prereqs." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker daemon unreachable. Is the service running? Are you in the docker group?" >&2
  exit 1
fi

echo "=== pnpm install ==="
pnpm install --filter '@agenthub/installer...' --prefer-offline 2>&1 | tail -5

echo "=== building installer ==="
pnpm --filter @agenthub/installer build 2>&1 | tail -3

# Build images unless the caller pinned published tags.
SERVER_IMAGE="${AGENTHUB_SERVER_IMAGE:-agenthubv2-server:local}"
WORKSPACE_IMAGE="${AGENTHUB_WORKSPACE_IMAGE:-agenthubv2-workspace:local}"
export AGENTHUB_SERVER_IMAGE="$SERVER_IMAGE"
export AGENTHUB_WORKSPACE_IMAGE="$WORKSPACE_IMAGE"

if [[ "$SERVER_IMAGE" == "agenthubv2-server:local" ]]; then
  echo "=== docker build server (agenthubv2-server:local) ==="
  docker build -f docker/Dockerfile.server -t "$SERVER_IMAGE" . | tail -3
fi

if [[ "$WORKSPACE_IMAGE" == "agenthubv2-workspace:local" ]]; then
  echo "=== docker build workspace (agenthubv2-workspace:local) ==="
  docker build -f docker/Dockerfile.agent-workspace -t "$WORKSPACE_IMAGE" . | tail -3
fi

echo "=== running installer ==="
exec node packages/installer/dist/index.js "$@"
