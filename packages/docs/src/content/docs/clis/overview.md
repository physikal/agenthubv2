---
title: Agent CLIs — overview
description: Which CLIs auto-install in every workspace, which are opt-in, and how to choose.
---

Every AgentHub workspace is a Debian 12 container with Node 22. The coding-agent CLIs are **not** baked into the image — they're managed through the [Packages page](/docs/web-ui/packages/) and installed into your home volume. Three "essential" CLIs install themselves on every session; the rest are one click away.

## Auto-installed every session (essentials)

These are flagged **essential** in the catalog. On every session-active, the agent daemon installs any that aren't already present into `/home/coder/.local/bin` (idempotent — already-installed ones are skipped). They're on `$PATH` once that finishes, a second or two after the terminal opens.

| Command | What it is | Page |
|---|---|---|
| `claude` | Anthropic's Claude Code CLI | [Claude Code](/docs/clis/claude-code/) |
| `opencode` | Open-source multi-model coding agent | [OpenCode](/docs/clis/opencode/) |
| `codex` | OpenAI's official Codex CLI | — |

Because they install to your home volume, they persist across session ends and image upgrades — the auto-install only does real work the first time.

Supporting tools **are** baked into the workspace image: `rclone`, `gh`, `preview`, `tmux`, `dtach`, `ripgrep`, `fzf`. See [Supporting tools](/docs/clis/supporting-tools/).

## Opt-in (via Packages)

The [Packages page](/docs/web-ui/packages/) lists the rest. These install into `/home/coder/.local/bin` only when you click **Install**, and persist across session ends the same way.

| Command | What it is | Page |
|---|---|---|
| `mmx` / `claude-minimax` | MiniMax's agent CLI + a `claude` shim with the MiniMax preset | [MiniMax](/docs/clis/minimax/) |
| `droid` | Factory AI's autonomous coding agent | [Droid](/docs/clis/droid/) |

More entries appear on the Packages page as we add manifests. A package is defined by a single entry in [`packages/server/src/services/packages/catalog.ts`](https://github.com/physikal/agenthubv2/blob/main/packages/server/src/services/packages/catalog.ts); set `essential: true` to make it auto-install.

## Which one should I use?

Honestly, it depends on the model you prefer and the tasks in front of you. A working mental model:

- **Claude Code** — the most polished Anthropic-backed agent. Good defaults, long context, honest about what it doesn't know. If you're on an Anthropic plan, start here.
- **OpenCode** — model-agnostic. Useful if you want to drive Gemini, OpenAI, or a local llama.cpp from the same agent loop.
- **MiniMax** — specialized for the MiniMax M2 family. Feels good on long refactor tasks with heavy tool use.
- **Droid** — Factory AI's take on the autonomous agent. Different UX, different defaults. Try it if the others feel too chatty.

You can switch between them inside one session. They all read and write the same `/home/coder` filesystem; they just differ in the model loop wrapped around it.

## What every agent sees

Every agent CLI inherits the workspace's environment. Notable pre-set env vars:

- `AGENTHUB_URL` — the public URL of your AgentHub install
- `AGENTHUB_SESSION_ID` — the current session id (used by `preview`)
- `AGENT_TOKEN` — per-session bearer token used by the `agentdeploy` MCP to authenticate back to the server (already wired up — you don't need to pass it yourself)
- `PORTAL_URL` — server-facing URL used by the agent daemon

Model-provider keys are **opt-in**. Save one on the [Integrations page](/docs/web-ui/integrations/) under "AI Providers" and AgentHub injects the matching env var (`ANTHROPIC_API_KEY`, `MINIMAX_API_KEY`+`MINIMAX_BASE_URL`, `OPENAI_API_KEY`) into every new session — vanilla `claude` and `claude-minimax` pick those up automatically. If you don't save a key, the CLIs still work; they just prompt you to sign in the first time you run them. Existing sessions don't see newly-saved keys — start a new session after saving.
