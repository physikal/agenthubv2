---
title: OpenCode
description: Open-source, multi-model coding agent — pre-installed in every workspace.
---

[OpenCode](https://opencode.ai) is an open-source coding agent that doesn't care which model it's talking to. It's installed as `opencode` in every workspace.

Use it when:

- You want to drive GPT-4o, Gemini 2.5, or a local llama.cpp from the same agent loop.
- You want an open-source tool you can read and patch if it misbehaves.
- Claude Code is down.

## Getting started

```bash
opencode
```

On first run OpenCode asks which model provider to use and how to authenticate. It supports most major providers plus any OpenAI-compatible endpoint. Pick what you like; credentials go into `~/.config/opencode/` (on your persistent volume).

## Common flags

```bash
# One-shot prompt:
opencode run "summarize the changes in my staged commits"

# Resume the most recent session:
opencode continue

# Switch provider mid-flight:
opencode provider
```

For the full command reference run:

```bash
opencode --help
```

## Model providers that work out of the box

- **Anthropic** — paste your `ANTHROPIC_API_KEY`
- **OpenAI** — paste `OPENAI_API_KEY`
- **Google** — `GOOGLE_GENERATIVE_AI_API_KEY`
- **OpenRouter** — a single key for all of the above
- **Local OpenAI-compatible** — any endpoint like `http://localhost:11434/v1` for Ollama, LM Studio, vLLM, etc.

OpenCode writes these into its own config file. If you want a key to persist across user deletions, store it as a secret in Infisical at `/users/{userId}/openai-key` and export it from `~/.bashrc`.

## When to prefer it over Claude Code

- **Model portability** — you want to compare Claude, GPT, and Gemini on the same task.
- **Self-hosted models** — you're running something locally and need an agent that respects `OPENAI_API_BASE`.
- **Offline** — OpenCode runs fully offline against a local model; Claude Code needs Anthropic reachable.

For anything involving long-context Claude-specific features (prompt caching, extended thinking, computer use), Claude Code still has better native support.

## Official docs

Full reference at **https://opencode.ai**. The GitHub repo is also the definitive source for MCP support, tool definitions, and the current provider list.

## AgentHub integration

OpenCode will pick up the `agentdeploy` MCP configured at `~/.claude/mcp.json` if you point it there with `opencode config mcp add`. Otherwise it runs with its default tool set and the workspace filesystem.
