---
title: Packages
description: Install extra coding-agent CLIs into your session on demand.
---

**Packages** is how you add CLIs that aren't baked into the workspace image. Today that's [Droid](/docs/clis/droid/); the catalog grows as we add manifests.

## What the page shows

Two columns for each entry:

- **Pre-installed** — CLIs baked into the workspace image (Claude Code, OpenCode, MiniMax). You can't remove these; they're part of the base system.
- **Installable** — CLIs the agent daemon can install into `/home/coder/.local/bin` in your active session. These persist across session ends because `.local/bin` is on your home volume.

Each row shows:

- Name + homepage link
- The installed version (if installed)
- An **Install** / **Remove** button

## Requires an active session

Package installs and removes run **inside** your workspace container, talking to the agent daemon over WebSocket. Without an active session, both buttons are disabled. The page shows a banner telling you to start one from the **Sessions** page first.

Two reasons for this design:

1. The install pulls a binary or runs a shell script — we want that to happen in the sandbox, not on the host.
2. The resulting binary lives on your per-user home volume, which is only mounted while a session container is up.

## How installs work

For each package, the catalog in [`packages/server/src/services/packages/catalog.ts`](https://github.com/physikal/agenthubv2/blob/main/packages/server/src/services/packages/catalog.ts) declares exactly one install method:

- **`npm`** — `npm install -g --prefix ~/.local <npmPackage>`
- **`curl-sh`** — `curl -fsSL <url> | sh` (with optional env vars)
- **`binary`** — direct download + `chmod +x` into `~/.local/bin/`

After install, the daemon runs `<binName> --version` (per the manifest) to confirm and capture the version string. If that fails, the install is reported as failed and the binary is removed.

## Removing

**Remove** runs a clean uninstall sequence — delete the binary from `~/.local/bin`, remove the catalog row from the daemon's local state, tell the server to clear its record. Credentials the tool left in `~/.config/` are **not** automatically removed; run `rm -rf ~/.config/<tool>` by hand if you want those gone.

## What the page does *not* do

- Install system packages (use `sudo apt install` in the terminal; those don't persist anyway).
- Install Python / Node dependencies in your project — use `pip`, `npm`, `pnpm` directly.
- Add remotes to existing CLIs (use each CLI's own config command).

## Why this approach

An AgentHub user might prefer any of a dozen coding agents. Baking all of them into the base image bloats pulls and couples their release cycles. The Packages page splits the difference: the most commonly used three ride in the image, and the rest install on demand with a one-button audit trail.

If you want a CLI added to the catalog, the manifest is tiny — see the file linked above and PR it.
