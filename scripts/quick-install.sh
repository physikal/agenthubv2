#!/usr/bin/env bash
#
# AgentHub v2 — one-liner install with auto-provisioned prereqs.
#
#   curl -fsSL https://raw.githubusercontent.com/physikal/agenthubv2/main/scripts/quick-install.sh | bash
#
# Headless / agent-driven (no prompts, auto-installs everything):
#   curl -fsSL https://.../quick-install.sh \
#     | AGENTHUB_AUTO_INSTALL=true \
#       AGENTHUB_MODE=docker \
#       AGENTHUB_DOMAIN=localhost \
#       AGENTHUB_ADMIN_PASSWORD=change-me \
#       bash -s -- --non-interactive
#
# What it handles end-to-end:
#   - Detects the Linux distro (debian/ubuntu, rhel/fedora/rocky/alma, arch, alpine)
#   - For each prereq (git, docker, docker compose plugin, node 22+, pnpm):
#       • Checks it
#       • If missing: prompts for consent (or reads AGENTHUB_AUTO_INSTALL=true)
#       • Installs via the distro's canonical path
#       • Re-verifies
#   - Starts the Docker daemon if it's installed but not running
#   - Adds the user to the `docker` group and warns if re-login is needed
#   - Clones the repo to ./agenthubv2 (or AGENTHUB_DIR) and hands off to
#     scripts/install.sh
#
# Safe to re-run. Idempotent. Never modifies anything it didn't install itself.
#
# Supported: Debian 11+/Ubuntu 22.04+, Fedora/RHEL 9+/Rocky/Alma, Arch, Alpine 3.18+.
# macOS: falls through to "please install docker desktop manually".

set -euo pipefail

# ---------------------------------------------------------------- config

REPO="${AGENTHUB_REPO:-https://github.com/physikal/agenthubv2.git}"
TARGET_DIR="${AGENTHUB_DIR:-$PWD/agenthubv2}"
BRANCH="${AGENTHUB_BRANCH:-main}"
AUTO="${AGENTHUB_AUTO_INSTALL:-}"
MIN_NODE_MAJOR=22
PNPM_VERSION="${AGENTHUB_PNPM_VERSION:-10.12.1}"

# ---------------------------------------------------------------- ui

c_reset=$'\033[0m'; c_bold=$'\033[1m'
c_cyan=$'\033[1;36m'; c_yel=$'\033[1;33m'; c_red=$'\033[1;31m'; c_grn=$'\033[1;32m'

msg()  { printf '%s[agenthub]%s %s\n' "$c_cyan" "$c_reset" "$*"; }
ok()   { printf '%s[ok]%s %s\n'        "$c_grn"  "$c_reset" "$*"; }
warn() { printf '%s[warn]%s %s\n'      "$c_yel"  "$c_reset" "$*" >&2; }
die()  { printf '%s[error]%s %s\n'     "$c_red"  "$c_reset" "$*" >&2; exit 1; }
step() { printf '\n%s▸ %s%s\n'         "$c_bold" "$*" "$c_reset"; }

have() { command -v "$1" >/dev/null 2>&1; }

interactive() {
  # stdin is a TTY (true install) — NOT true when piped through `curl | bash`,
  # in which case we rely on AGENTHUB_AUTO_INSTALL=true.
  [[ -t 0 ]]
}

confirm() {
  local what="$1"
  if [[ "$AUTO" == "true" ]]; then
    msg "AGENTHUB_AUTO_INSTALL=true → installing ${what} without prompting"
    return 0
  fi
  if ! interactive; then
    die "${what} is required but missing. Stdin is not a TTY (piped through bash), \
so I can't prompt. Re-run with:
    curl -fsSL .../quick-install.sh | AGENTHUB_AUTO_INSTALL=true bash
OR install ${what} manually first and re-run."
  fi
  read -r -p "$(printf '%s[?]%s Install %s now? [Y/n] ' "$c_yel" "$c_reset" "$what")" reply
  reply="${reply:-Y}"
  [[ "$reply" =~ ^[Yy] ]]
}

# ---------------------------------------------------------------- sudo + distro

SUDO=""
detect_sudo() {
  if [[ "$(id -u)" -eq 0 ]]; then SUDO=""; return; fi
  if ! have sudo; then
    die "Not running as root and 'sudo' isn't installed. Re-run as root or install sudo."
  fi
  # Quick non-interactive probe — if passwordless sudo works, great; otherwise
  # sudo will prompt for password the first time it's actually used.
  SUDO="sudo"
  if ! sudo -n true 2>/dev/null; then
    warn "sudo may prompt for your password during install"
  fi
}

DISTRO=""
DISTRO_FAMILY=""
detect_distro() {
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    DISTRO="${ID:-unknown}"
    case "$DISTRO" in
      debian|ubuntu|raspbian|pop|linuxmint) DISTRO_FAMILY=debian ;;
      fedora|rhel|rocky|almalinux|centos|ol) DISTRO_FAMILY=rhel ;;
      arch|manjaro|endeavouros) DISTRO_FAMILY=arch ;;
      alpine) DISTRO_FAMILY=alpine ;;
      *) DISTRO_FAMILY="$(echo "${ID_LIKE:-}" | awk '{print $1}')"
         case "$DISTRO_FAMILY" in
           debian|ubuntu) DISTRO_FAMILY=debian ;;
           rhel|fedora) DISTRO_FAMILY=rhel ;;
           arch) DISTRO_FAMILY=arch ;;
           *) DISTRO_FAMILY="" ;;
         esac
         ;;
    esac
  elif [[ "$(uname -s)" == "Darwin" ]]; then
    DISTRO=macos
    DISTRO_FAMILY=macos
  fi
  if [[ -z "$DISTRO_FAMILY" ]]; then
    die "Unsupported OS ($DISTRO). Supported: Debian/Ubuntu, Fedora/RHEL/Rocky, Arch, Alpine.
Install Docker + Node 22 + pnpm manually, then re-run scripts/install.sh."
  fi
  msg "detected: $DISTRO ($DISTRO_FAMILY)"
}

# ---------------------------------------------------------------- apt lock wait

wait_for_apt() {
  [[ "$DISTRO_FAMILY" != "debian" ]] && return 0
  local waited=0
  while $SUDO fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1; do
    if [[ "$waited" -eq 0 ]]; then
      warn "another apt process is running — waiting up to 60s"
    fi
    sleep 2
    waited=$((waited + 2))
    if [[ "$waited" -ge 60 ]]; then
      die "apt still locked after 60s. Stop the other installer and re-run."
    fi
  done
}

pkg_install() {
  local pkgs=("$@")
  case "$DISTRO_FAMILY" in
    debian)
      wait_for_apt
      $SUDO apt-get update -qq
      DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq --no-install-recommends "${pkgs[@]}"
      ;;
    rhel)
      if have dnf; then $SUDO dnf install -y -q "${pkgs[@]}"
      else $SUDO yum install -y -q "${pkgs[@]}"; fi
      ;;
    arch)   $SUDO pacman -Sy --noconfirm --needed "${pkgs[@]}" ;;
    alpine) $SUDO apk add --no-cache "${pkgs[@]}" ;;
    *) die "pkg_install: unsupported family $DISTRO_FAMILY" ;;
  esac
}

# ---------------------------------------------------------------- git

ensure_git() {
  step "git"
  if have git; then ok "git $(git --version | awk '{print $3}')"; return; fi
  confirm git || die "git required"
  pkg_install git
  have git || die "git install appears to have failed"
  ok "git installed"
}

# ---------------------------------------------------------------- curl + ca-certificates (used by subsequent installs)

ensure_curl() {
  if have curl; then return; fi
  step "curl"
  confirm curl || die "curl required"
  case "$DISTRO_FAMILY" in
    debian|rhel|arch|alpine) pkg_install curl ca-certificates ;;
  esac
}

# ---------------------------------------------------------------- docker

ensure_docker_daemon_running() {
  if docker info >/dev/null 2>&1; then return; fi
  if have systemctl; then
    msg "starting docker daemon"
    $SUDO systemctl enable --now docker 2>/dev/null || true
    sleep 3
  elif [[ "$DISTRO_FAMILY" == "alpine" ]]; then
    $SUDO rc-update add docker default 2>/dev/null || true
    $SUDO service docker start 2>/dev/null || true
    sleep 3
  fi
  if ! docker info >/dev/null 2>&1; then
    # Daemon is up but this shell can't reach it — most commonly because
    # the user isn't in the `docker` group. Add them and install the same
    # sudo-wrapper `install_docker` uses so this run keeps moving; group
    # membership will be in effect on the next login.
    if [[ "$(id -u)" -ne 0 ]] && ! groups "$USER" 2>/dev/null | grep -qw docker; then
      warn "you're not in the 'docker' group yet"
      msg "adding $USER to docker group"
      $SUDO usermod -aG docker "$USER"
      warn "docker group membership requires re-login. Continuing with sudo for this run."
      docker() { $SUDO /usr/bin/docker "$@"; }
      export -f docker
      docker info >/dev/null 2>&1 || die "docker still unreachable even with sudo wrapper"
      return
    fi
    die "docker daemon still unreachable. Try:  sudo systemctl status docker"
  fi
}

ensure_docker() {
  step "docker"
  if have docker; then
    ensure_docker_daemon_running
    ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"
  else
    confirm "Docker (via get.docker.com)" || die "Docker required"
    # Docker's official convenience script. Works on Debian, Ubuntu, Fedora,
    # CentOS/RHEL, Raspbian. NOT recommended for production, but exactly right
    # for a self-host install.
    ensure_curl
    curl -fsSL https://get.docker.com | $SUDO sh
    ensure_docker_daemon_running
    # Add current user to docker group so they don't need sudo for docker commands.
    if [[ "$(id -u)" -ne 0 ]] && ! groups "$USER" 2>/dev/null | grep -qw docker; then
      msg "adding $USER to docker group"
      $SUDO usermod -aG docker "$USER"
      warn "docker group membership requires re-login. Continuing with sudo for now."
      # Use a wrapper so the rest of this script works without re-login.
      docker() { $SUDO /usr/bin/docker "$@"; }
      export -f docker
    fi
    ok "docker installed"
  fi

  # Docker Compose plugin — the `docker compose` subcommand (not legacy
  # docker-compose). get.docker.com includes it; on older installs it doesn't.
  if ! docker compose version >/dev/null 2>&1; then
    step "docker compose plugin"
    confirm "docker-compose-plugin" || die "docker compose plugin required"
    case "$DISTRO_FAMILY" in
      debian) pkg_install docker-compose-plugin ;;
      rhel)   pkg_install docker-compose-plugin ;;
      arch)   pkg_install docker-compose ;;
      alpine) pkg_install docker-cli-compose ;;
    esac
    docker compose version >/dev/null 2>&1 || die "docker compose still not available"
    ok "docker compose plugin installed"
  fi
}

# ---------------------------------------------------------------- node 22

ensure_node() {
  step "node 22+"
  local major=0
  if have node; then
    major="$(node -p 'parseInt(process.versions.node.split(".")[0],10)' 2>/dev/null || echo 0)"
  fi
  if [[ "$major" -ge "$MIN_NODE_MAJOR" ]]; then
    ok "node $(node --version)"
    return
  fi

  if [[ "$major" -gt 0 && "$major" -lt "$MIN_NODE_MAJOR" ]]; then
    warn "node $major detected; AgentHub needs node $MIN_NODE_MAJOR+"
  fi

  confirm "Node.js $MIN_NODE_MAJOR" || die "Node $MIN_NODE_MAJOR+ required"
  ensure_curl

  # ${SUDO:+$SUDO -E} expands to "$SUDO -E" only when SUDO is non-empty —
  # when we're already root it collapses to nothing, avoiding a bogus `-E`
  # passed to bash that yields "-E: command not found".
  case "$DISTRO_FAMILY" in
    debian)
      curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | ${SUDO:+$SUDO -E} bash -
      pkg_install nodejs
      ;;
    rhel)
      curl -fsSL "https://rpm.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | ${SUDO:+$SUDO -E} bash -
      pkg_install nodejs
      ;;
    arch)   pkg_install nodejs npm ;;
    alpine) pkg_install nodejs npm ;;
  esac
  have node || die "node install appears to have failed"
  local new_major
  new_major="$(node -p 'parseInt(process.versions.node.split(".")[0],10)')"
  if [[ "$new_major" -lt "$MIN_NODE_MAJOR" ]]; then
    die "installed node $new_major but AgentHub needs $MIN_NODE_MAJOR+. Upgrade manually."
  fi
  ok "node $(node --version) installed"
}

# ---------------------------------------------------------------- pnpm

ensure_pnpm() {
  step "pnpm $PNPM_VERSION"
  if have pnpm; then ok "pnpm $(pnpm --version)"; return; fi
  confirm "pnpm $PNPM_VERSION (via corepack)" || die "pnpm required"

  if ! have corepack; then
    # Older node ships without corepack — use npm as a fallback.
    if have npm; then
      $SUDO npm install -g "pnpm@$PNPM_VERSION" >/dev/null 2>&1 || \
        die "npm install -g pnpm failed. Try:  $SUDO npm install -g pnpm@$PNPM_VERSION"
    else
      die "corepack missing and npm missing. Reinstall Node 22+ or install pnpm manually."
    fi
  else
    corepack enable >/dev/null 2>&1 || true
    corepack prepare "pnpm@$PNPM_VERSION" --activate >/dev/null 2>&1 || \
      die "corepack prepare pnpm failed. Try:  $SUDO npm install -g pnpm@$PNPM_VERSION"
    # corepack may only put pnpm on PATH in new shells — make sure THIS shell
    # can find it.
    if ! have pnpm; then
      local pnpm_bin
      pnpm_bin="$(ls -1 "$HOME/.cache/node/corepack/v1/pnpm/"*/bin/pnpm.cjs 2>/dev/null | tail -1 || true)"
      if [[ -n "$pnpm_bin" ]]; then
        mkdir -p "$HOME/.local/bin"
        ln -sf "$pnpm_bin" "$HOME/.local/bin/pnpm"
        export PATH="$HOME/.local/bin:$PATH"
      fi
    fi
  fi
  have pnpm || die "pnpm still not on PATH. Add ~/.local/bin to PATH and re-run."
  ok "pnpm $(pnpm --version) installed"
}

# ---------------------------------------------------------------- clone + hand off

clone_or_update() {
  step "fetching AgentHub v2"
  if [[ -d "$TARGET_DIR/.git" ]]; then
    msg "repo already at $TARGET_DIR — pulling latest"
    git -C "$TARGET_DIR" fetch origin "$BRANCH" --depth=1 --quiet || die "git fetch failed"
    git -C "$TARGET_DIR" reset --hard "origin/$BRANCH" --quiet
  else
    msg "cloning $REPO → $TARGET_DIR"
    git clone --depth=1 --branch "$BRANCH" --quiet "$REPO" "$TARGET_DIR" || die "git clone failed"
  fi
  ok "source at $TARGET_DIR"
}

# ---------------------------------------------------------------- main

main() {
  printf '\n%s=== AgentHub v2 quick-install ===%s\n' "$c_bold" "$c_reset"
  msg "will auto-install missing prereqs (git, docker, node 22, pnpm) with your consent"

  detect_sudo
  detect_distro

  ensure_curl
  ensure_git
  ensure_docker
  ensure_node
  ensure_pnpm
  clone_or_update

  cd "$TARGET_DIR"
  step "launching installer"
  exec ./scripts/install.sh "$@"
}

main "$@"
