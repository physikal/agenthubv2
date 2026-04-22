---
title: Agent CLIs — overview
description: Which CLIs ship in every workspace, which are installable on demand, and how to choose.
---

Every AgentHub workspace is a Debian 12 container with Node 22 and a handful of coding-agent CLIs pre-installed. Anything not pre-installed is one click away on the [Packages page](/docs/web-ui/packages/).

## Pre-installed in the workspace image

These are baked into `agenthubv2-workspace:local` (the image built during install). They're on `$PATH` immediately when you open the terminal.

| Command | What it is | Page |
|---|---|---|
| `claude` | Anthropic's Claude Code CLI | [Claude Code](/docs/clis/claude-code/) |
| `opencode` | Open-source multi-model coding agent | [OpenCode](/docs/clis/opencode/) |
| `mmx` | MiniMax's official agent CLI | [MiniMax](/docs/clis/minimax/) |
| `claude-minimax` | Shim: `claude` with the MiniMax model preset | [MiniMax](/docs/clis/minimax/) |

Supporting tools also baked in: `rclone`, `gh`, `preview`, `tmux`, `dtach`, `ripgrep`, `fzf`. See [Supporting tools](/docs/clis/supporting-tools/).

## Installable on demand (via Packages)

The [Packages page](/docs/web-ui/packages/) in the web UI lists additional CLIs you can install into `/home/coder/.local/bin` in the active session. Because they install into your home volume, they persist across session ends.

| Command | What it is | Page |
|---|---|---|
| `droid` | Factory AI's autonomous coding agent | [Droid](/docs/clis/droid/) |

More entries will appear on the Packages page as we add manifests. A package is defined by a single entry in [`packages/server/src/services/packages/catalog.ts`](https://github.com/physikal/agenthubv2/blob/main/packages/server/src/services/packages/catalog.ts).

## Which one should I use?

Honestly, it depends on the model you prefer and the tasks in front of you. A working mental model:

- **Claude Code** — the most polished Anthropic-backed agent. Good defaults, long context, honest about what it doesn't know. If you're on an Anthropic plan, start here.
- **OpenCode** — model-agnostic. Useful if you want to drive Gemini, OpenAI, or a local llama.cpp from the same agent loop.
- **MiniMax** — specialized for the MiniMax M2 family. Feels good on long refactor tasks with heavy tool use.
- **Droid** — Factory AI's take on the autonomous agent. Different UX, different defaults. Try it if the others feel too chatty.

You can switch between them inside one session. They all read and write the same `/home/coder` filesystem; they just differ in the model loop wrapped around it.

## What every agent sees

All four CLIs inherit the workspace's environment. Notable pre-set env vars:

- `AGENTHUB_URL` — the public URL of your AgentHub install
- `AGENTHUB_SESSION_ID` — the current session id (used by `preview`)
- `AGENT_TOKEN` — per-session bearer token used by the `agentdeploy` MCP to authenticate back to the server (already wired up — you don't need to pass it yourself)
- `PORTAL_URL` — server-facing URL used by the agent daemon

No API keys for external model providers are pre-set. You sign into each CLI separately the first time you run it.
