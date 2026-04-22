---
title: Droid (Factory AI)
description: Factory AI's autonomous coding agent — installable on demand from the Packages page.
---

[Droid](https://app.factory.ai) is Factory AI's coding agent CLI. Unlike Claude Code, OpenCode, and MiniMax, Droid is **not pre-installed** — it lives on the [Packages page](/docs/web-ui/packages/), one click away.

## Install it

1. Start a session (Droid is installed into your session's home volume, so you need an active session).
2. Go to **Packages** in the sidebar.
3. Find **Droid (Factory AI)**, click **Install**.
4. Watch the progress. When it reports *installed*, the `droid` binary is at `~/.local/bin/droid`, which is already on your `$PATH` inside workspace shells.

Behind the scenes, the agent daemon runs `curl -fsSL https://app.factory.ai/cli | sh` and captures the version. Because the installer writes to `/home/coder/.local/bin`, Droid **persists across session ends**. You only install it once per user.

## First run

```bash
droid
```

On first run Droid opens a browser flow (via the URL it prints) for signing into your Factory AI account. The token lands in `~/.config/factory/` — same persistence story as the other CLIs.

## Common usage

```bash
# REPL
droid

# One-shot
droid exec "write unit tests for the dbClient class"

# Dry-run — show what it would do without actually running tool calls
droid exec --plan "migrate from sqlite to postgres"
```

Droid has a different UX than Claude Code — it's more aggressive about planning before acting, and it maintains longer-lived "projects" that persist across invocations. If you like that, it'll feel good; if you prefer Claude Code's more direct "do what I say" mode, stay there.

## Uninstalling

The [Packages page](/docs/web-ui/packages/) has a **Remove** button — that's the canonical path. It removes the `droid` binary from `~/.local/bin` and clears the metadata row. Your `~/.config/factory/` credentials stay on disk so you can reinstall later without re-authing; `rm -rf ~/.config/factory` manually if you want those gone too.

## Official docs

- **Product site:** https://app.factory.ai
- **Docs:** https://docs.factory.ai

## When to pick it over the built-ins

- You prefer Factory AI's planner-first agent loop.
- You use Factory's "droids" (specialized agents) in your day job and want the same in AgentHub.
- Claude Code and OpenCode both disagree with your vibe.
