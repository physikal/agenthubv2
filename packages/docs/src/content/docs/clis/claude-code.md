---
title: Claude Code
description: Anthropic's official coding-agent CLI, pre-installed in every AgentHub workspace.
---

[Claude Code](https://docs.claude.com/en/docs/claude-code/overview) is Anthropic's official coding agent. It's installed as `claude` in every workspace, updated to the latest stable release when the workspace image is rebuilt.

## First-time sign-in

You can authenticate two ways. Pick whichever fits your workflow:

### Option 1 — API key from Integrations (zero-prompt)

Save your Anthropic API key on the [Integrations page](/docs/web-ui/integrations/) → **AI Providers** → **Anthropic API**. AgentHub injects `ANTHROPIC_API_KEY` into every new session, and Claude Code uses it automatically — no OAuth flow, no prompts. Existing sessions don't pick up newly-saved keys; start a new session after saving.

### Option 2 — OAuth in the workspace

```bash
claude
```

On first run you'll see:

```
To authenticate, visit https://claude.ai/oauth/authorize?code=XYZ-ABC
and enter the code: XYZ-ABC
```

Open the URL in your browser, sign in with your Anthropic account, authorize the CLI, and Claude Code saves a token in `~/.claude/` inside the workspace. Because `~/.claude` sits on your persistent home volume, **you only do this once per user**, not per session.

Both methods work; the API-key route is faster the first time and survives volume rebuilds because the key lives in Infisical, not on the workspace filesystem. The OAuth route is what the official Claude documentation describes and tracks usage against your Claude.ai account.

## Basic usage

Interactive REPL:

```bash
claude
```

One-shot prompt:

```bash
claude -p "review packages/server/src/index.ts for obvious bugs"
```

Resume the last conversation:

```bash
claude --continue
```

From-repo mode (it reads the repo context on startup):

```bash
cd ~/repo
claude
```

## Switching models

```bash
# inside the REPL
/model claude-opus-4-7

# or at launch
claude --model claude-opus-4-7
```

The `--model` flag takes any model id Anthropic currently exposes — see [the Claude docs](https://docs.claude.com/en/docs/claude-code/overview) for the current list.

## Running with MiniMax via the shim

Every workspace also has a `claude-minimax` shim that's literally:

```bash
exec claude --model minimax/MiniMax-M2.7 --dangerously-skip-permissions "$@"
```

If you want Claude Code's UX with a MiniMax model for a specific run, use `claude-minimax` instead of `claude`. See [MiniMax](/docs/clis/minimax/).

## Useful slash commands inside the REPL

| Command | What it does |
|---|---|
| `/clear` | Reset the conversation. Cheap way to drop context when a session has gone off the rails. |
| `/model` | Switch model mid-conversation. |
| `/cost` | Show cumulative token spend for the current session. |
| `/help` | Built-in help — current and authoritative. |

## The MCP loadout inside AgentHub

Claude Code auto-discovers MCP servers configured in `~/.claude/mcp.json`. The AgentHub agent daemon seeds one for you:

- **`agentdeploy`** — lets Claude Code deploy arbitrary apps to configured hosting providers. See [agentdeploy MCP](/docs/agentdeploy/overview/) for the full tool reference.

You can add more with `claude mcp add`; they'll be scoped to your user (home volume).

## Auth token safety

Your Claude Code OAuth token sits in `~/.claude/` inside your workspace volume. It is **not** encrypted at rest — anyone with shell access to your workspace container can read it. That's the same posture as running Claude Code on your laptop; AgentHub doesn't change the threat model, it just moves it to your server.

If you want to rotate, run `claude logout` from the REPL — that clears the token and triggers the sign-in flow again next time.

## Official docs

For the features Anthropic updates frequently — tool use, prompt caching, reasoning models, subagents, plans — defer to the upstream site:

- **Overview:** https://docs.claude.com/en/docs/claude-code/overview
- **Configuration:** https://docs.claude.com/en/docs/claude-code/settings
- **MCP reference:** https://docs.claude.com/en/docs/claude-code/mcp

This page only documents the AgentHub-specific context.
