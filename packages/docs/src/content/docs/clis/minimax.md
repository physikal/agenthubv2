---
title: MiniMax (mmx + claude-minimax)
description: The MiniMax M2 agent, plus a Claude Code shim for the same model.
---

[MiniMax](https://www.minimax.io) publishes a family of coding-specialist models (the M2 line) and an official CLI called `mmx`. Both `mmx` and a `claude-minimax` convenience shim are pre-installed in every workspace.

## Two ways in

### `mmx` — the native CLI

```bash
mmx
```

This is MiniMax's first-party agent loop. On first run it'll ask for a MiniMax API key. Get one from [minimax.io](https://www.minimax.io), paste it in, and you're live. Credentials land in `~/.config/mmx/` on the workspace volume.

Common operations:

```bash
mmx --help          # full help
mmx chat            # interactive REPL
mmx run "fix the failing test in packages/server"
```

### `claude-minimax` — Claude Code's UX, MiniMax's model

If you prefer Claude Code's interface but want the MiniMax M2.7 model, run:

```bash
claude-minimax
```

The shim is literally:

```bash
#!/bin/bash
exec claude --model minimax/MiniMax-M2.7 --dangerously-skip-permissions "$@"
```

It forwards any extra args to `claude`, so `claude-minimax -p "review this file"` works exactly like `claude -p ...` with the model flag pre-applied.

`--dangerously-skip-permissions` is passed because MiniMax routing in Claude Code doesn't participate in the usual permission loop — the shim opts out. Understand what that means: **any tool the agent calls runs without asking you first**. If you want the permission UI, run plain `claude --model minimax/MiniMax-M2.7` instead.

## When to pick each

- **`mmx`** when you want MiniMax's own tool definitions, long-running-task mode, and the features they've built on top of M2.
- **`claude-minimax`** when you want Claude Code's UX (sidebars, subagents, `/commands`) and just want to swap the model.

Models available through both change over time. See [minimax.io/docs](https://www.minimax.io) for the current list.

## Auth token safety

Same posture as Claude Code — tokens sit on disk in your home volume, not encrypted at rest. If you rotate keys in the MiniMax dashboard, remove the old one from `~/.config/mmx/` so the CLI re-prompts.

## Official docs

For model details, pricing, rate limits, and anything that changes frequently:

- **Website:** https://www.minimax.io
- **API docs:** https://www.minimax.io/platform/document

This page only covers the AgentHub-specific plumbing.
