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

#### One-time setup

Save your MiniMax key in AgentHub:

1. Open the **Integrations** page in the web UI
2. Click **Add integration** → **MiniMax**
3. Paste your `apiKey` (and optionally a custom `baseUrl`)
4. Save

The server injects `MINIMAX_API_KEY` (and `MINIMAX_BASE_URL` if you customised it) into every new session's environment. Existing sessions don't pick up newly-saved keys — start a fresh session.

Without the key the shim fails fast with a pointer back to this flow. Calling vanilla `claude` against a `minimax/...` model wouldn't do what you want — Claude Code routes by `ANTHROPIC_BASE_URL`, not by model prefix.

#### Under the hood

The shim sets `ANTHROPIC_BASE_URL` to MiniMax's Anthropic-compatible endpoint, attaches your key as `ANTHROPIC_AUTH_TOKEN`, and exec's `claude --model MiniMax-M2.7 --dangerously-skip-permissions "$@"`. Extra args forward through, so `claude-minimax -p "review this file"` works exactly like the equivalent `claude` invocation.

`--dangerously-skip-permissions` is on because MiniMax routing doesn't participate in Claude Code's usual permission loop — **any tool the agent calls runs without asking you first.** If you want the permission UI, run `claude --model MiniMax-M2.7` directly (no `claude-minimax`) once your key is set.

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
