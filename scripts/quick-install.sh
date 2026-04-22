#!/usr/bin/env bash
#
# AgentHub v2 — one-liner install.
#
# Download, inspect, then pipe if you trust it:
#   curl -fsSL https://raw.githubusercontent.com/physikal/agenthubv2/main/scripts/quick-install.sh | bash
#
# Or, for a headless / agent-driven run:
#   curl -fsSL https://raw.githubusercontent.com/physikal/agenthubv2/main/scripts/quick-install.sh \
#     | AGENTHUB_MODE=docker AGENTHUB_DOMAIN=localhost AGENTHUB_ADMIN_PASSWORD=change-me \
#       bash -s -- --non-interactive
#
# What it does (idempotent, safe to re-run):
#   1. Verify prereqs (docker + git + node + pnpm)
#   2. Clone github.com/physikal/agenthubv2 to ${AGENTHUB_DIR:-./agenthubv2} (or git pull
#      if it's already there)
#   3. Exec scripts/install.sh with any args you passed after `bash -s --`
#
# This script does NOT sudo, modify your global PATH, or install anything
# outside the clone dir (except corepack-activating pnpm, which lives in
# your user's cache).

set -euo pipefail

REPO="${AGENTHUB_REPO:-https://github.com/physikal/agenthubv2.git}"
TARGET_DIR="${AGENTHUB_DIR:-$PWD/agenthubv2}"
BRANCH="${AGENTHUB_BRANCH:-main}"

msg()  { printf '\033[1;36m[agenthub]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }

check() {
  command -v "$1" >/dev/null 2>&1 || return 1
}

require_docker() {
  if ! check docker; then
    err "docker not installed. See https://docs.docker.com/engine/install/"
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    err "docker daemon unreachable (is the service running? are you in the docker group?)"
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    err "docker compose plugin not installed"
    exit 1
  fi
}

require_git() {
  if ! check git; then
    err "git not installed. sudo apt-get install -y git  (or your distro's equivalent)"
    exit 1
  fi
}

require_node() {
  if ! check node; then
    err "node 22+ not installed. See https://nodejs.org/ or use nvm."
    exit 1
  fi
  local major
  major="$(node -p 'parseInt(process.versions.node.split(".")[0],10)')"
  if [[ "$major" -lt 22 ]]; then
    err "node $major detected; AgentHub needs node 22+."
    exit 1
  fi
}

ensure_pnpm() {
  if check pnpm; then return; fi
  msg "pnpm not found — activating via corepack"
  if ! check corepack; then
    err "corepack not available. Install Node 22+ (ships with corepack) or:  npm install -g pnpm@10.12.1"
    exit 1
  fi
  corepack enable >/dev/null 2>&1 || warn "corepack enable failed (may need sudo, non-fatal)"
  corepack prepare pnpm@10.12.1 --activate >/dev/null 2>&1 || {
    err "corepack prepare pnpm failed. Try:  npm install -g pnpm@10.12.1"
    exit 1
  }
  # corepack puts pnpm under ~/.cache/node/corepack/...; the shim is only on
  # PATH in new shells. Symlink into ~/.local/bin for this process.
  mkdir -p "$HOME/.local/bin"
  local pnpm_bin
  pnpm_bin="$(ls -1 "$HOME/.cache/node/corepack/v1/pnpm/"*/bin/pnpm.cjs 2>/dev/null | tail -1 || true)"
  if [[ -n "$pnpm_bin" ]]; then
    ln -sf "$pnpm_bin" "$HOME/.local/bin/pnpm"
    export PATH="$HOME/.local/bin:$PATH"
  fi
  if ! check pnpm; then
    err "pnpm still not on PATH. Add ~/.local/bin to PATH manually and re-run."
    exit 1
  fi
}

clone_or_update() {
  if [[ -d "$TARGET_DIR/.git" ]]; then
    msg "repo already cloned at $TARGET_DIR — pulling latest"
    git -C "$TARGET_DIR" fetch origin "$BRANCH" --depth=1 --quiet
    git -C "$TARGET_DIR" reset --hard "origin/$BRANCH" --quiet
  else
    msg "cloning $REPO → $TARGET_DIR"
    git clone --depth=1 --branch "$BRANCH" --quiet "$REPO" "$TARGET_DIR"
  fi
}

main() {
  msg "AgentHub v2 quick-install"
  require_docker
  require_git
  require_node
  ensure_pnpm
  clone_or_update

  cd "$TARGET_DIR"
  msg "handing off to scripts/install.sh"
  exec ./scripts/install.sh "$@"
}

main "$@"
