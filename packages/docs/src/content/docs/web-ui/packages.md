---
title: Packages
description: Install and update coding-agent CLIs in your session.
---

**Packages** is where every coding-agent CLI lives. None of them are baked into the workspace image any more — they're all installed into your per-user home volume, so the base image stays small and each tool's release cycle is decoupled from ours.

The catalog today: [Claude Code](/docs/clis/claude-code/), [OpenCode](/docs/clis/opencode/), [OpenAI Codex](/docs/clis/overview/), [MiniMax](/docs/clis/minimax/), and [Droid](/docs/clis/droid/). It grows as we add manifests.

## Essentials install themselves

Three CLIs are flagged **essential** — Claude Code, OpenCode, and Codex. On every session-active, the agent daemon auto-installs any of them that aren't already present into `/home/coder/.local/bin`. The install is idempotent: a binary that's already there is skipped, so this costs nothing on a warm home volume.

Everything else (MiniMax, Droid) is **opt-in** — it installs only when you click **Install**.

Because `.local/bin` is on your home volume, installs persist across session ends and image upgrades.

## What the page shows

Each tool is a card with:

- Name, description, and homepage link
- A status dot + label (Not installed / Installed / Installing… / Install failed)
- An **Essential** badge if it auto-installs
- The **installed version**, captured from `<binName> --version` after install
- An **Update available — `<installed>` → `<latest>`** badge when a newer upstream version exists
- **Install** / **Update** / **Remove** buttons as appropriate
- A "Last checked" timestamp for the version data

## Version checks run server-side

A poller runs every 30 minutes and caches each tool's latest upstream version in a `package_version_cache` table (npm registry for the npm-installed tools). The page reads from that cache — so the **Update** badge shows up without you having to hit refresh, and the check doesn't depend on a session being live.

The **Update** button reinstalls the tool at the latest version. Same install path as a fresh install; the new binary replaces the old one in `~/.local/bin`.

## Requires an active session

Install / Update / Remove all run **inside** your workspace container, talking to the agent daemon over WebSocket. Without an active session those buttons are disabled and a banner tells you to start one from the **Sessions** page first.

Two reasons:

1. The install pulls a binary or runs a shell script — we want that in the sandbox, not on the host.
2. The resulting binary lives on your per-user home volume, which is only mounted while a session container is up.

(The auto-install of essentials also runs inside the session — it fires the moment the daemon connects.)

## How installs work

For each package, the catalog in [`packages/server/src/services/packages/catalog.ts`](https://github.com/physikal/agenthubv2/blob/main/packages/server/src/services/packages/catalog.ts) declares exactly one install method:

- **`npm`** — `npm install -g --prefix ~/.local <npmPackage>`
- **`curl-sh`** — `curl -fsSL <url> | sh` (with optional env vars)
- **`binary`** — direct download + `chmod +x` into `~/.local/bin/`

After install, the daemon runs `<binName> --version` (per the manifest) to confirm and capture the version string. If that fails, the install is reported as failed and the binary is removed.

## Removing

**Remove** runs a clean uninstall sequence — delete the binary from `~/.local/bin`, remove the catalog row from the daemon's local state, tell the server to clear its record. Credentials the tool left in `~/.config/` are **not** automatically removed; run `rm -rf ~/.config/<tool>` by hand if you want those gone.

Removing an essential is allowed, but it'll reinstall on your next session-active.

## What the page does *not* do

- Install system packages (use `sudo apt install` in the terminal; those don't persist anyway).
- Install Python / Node dependencies in your project — use `pip`, `npm`, `pnpm` directly.
- Add remotes to existing CLIs (use each CLI's own config command).
- Update the bundled stack images (Traefik, Postgres, Redis, Infisical). That's the admin-only [Updates](/docs/web-ui/updates/) page.

## Why this approach

An AgentHub user might prefer any of a dozen coding agents. Baking all of them into the base image bloats pulls and couples their release cycles. The Packages page splits the difference: the three most-used ride in on session start, the rest install on demand, and a server-side poller keeps the "is there a newer version?" answer fresh without a session being open.

If you want a CLI added to the catalog, the manifest is tiny — see the file linked above and PR it.
