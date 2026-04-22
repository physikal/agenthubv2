---
title: The agentdeploy MCP
description: What the agentdeploy MCP is, how it's wired into every session, and what agents can do with it.
---

`agentdeploy` is a [Model Context Protocol](https://modelcontextprotocol.io) server that runs inside every AgentHub workspace. It exposes a small set of tools that let the agent in your session deploy **its own apps** — dev servers, dashboards, demos, whatever — to real hosting providers without leaving the session.

The agent inside a workspace calls `agentdeploy.deploy_app(...)`; AgentHub handles the rest: reading your Integrations, talking to the provider's API or SSHing into a host, writing a [Deployment](/docs/web-ui/deployments/) row, and returning a URL.

## Why this exists

Agents are good at writing code and bad at ops. "Make me a thing and show it working" shouldn't require 14 stops at the DigitalOcean UI, an SSH key, a Traefik config, and a Cloudflare zone edit. The MCP collapses all of that to one tool call.

## How it's registered

The agent daemon inside a workspace writes an MCP server entry into Claude Code's config on startup:

```json
{
  "mcpServers": {
    "agentdeploy": {
      "type": "stdio",
      "command": "node",
      "args": ["/opt/agenthub-agent/dist/mcp-server.js"]
    }
  }
}
```

Claude Code auto-discovers it. For OpenCode / MiniMax / Droid, configuring their own MCP pickup will auto-detect the server too — see each CLI's docs for the exact config command.

The MCP server (running as a Node subprocess inside the workspace) talks back to the AgentHub server over HTTP using the per-session `AGENT_TOKEN` env var. The server exposes `/api/agent/deploy` endpoints that accept that token for auth, scoped to the one session it was issued for. No other auth surface inside the workspace is exposed.

## One session → one token → one user

The `AGENT_TOKEN` is generated when the session is created, written to the workspace container's environment, and immediately forgotten by AgentHub (except as a hash in the `session_tokens` table). The token scopes calls to:

- The user who owns the session
- That one session only

This means:

- The agent can deploy apps tied to **your** account, not someone else's.
- The agent's auth is revoked automatically when the session ends.
- You can't impersonate another user, even if you steal their token at runtime.

## What tools the MCP exposes

From an agent's perspective:

- `list_hosting_providers` — what's configured on the Integrations page for you (docker / DigitalOcean / Dokploy).
- `deploy_app` — deploy something.
- `destroy_app` — tear it down.
- `list_deployments` — your own deployment inventory (matches the Deployments page).
- `get_deployment_status` — live status of a named deployment.

See [Supported providers](/docs/agentdeploy/providers/) for parameter details and per-provider behavior.

## When *not* to use it

- **Deploying infrastructure unrelated to the agent's work** — spinning up prod database clusters, managing secrets for external services. Use a proper infra tool.
- **Production deployments with strict approval flows.** The MCP deploys on agent request, immediately. If you need a PR-based CI gate, use it.
- **Anything where the agent shouldn't have authority to spend money.** A DigitalOcean deploy creates a droplet that bills you.

## Disabling it

The MCP is registered per session. If you don't want it, edit `~/.claude/mcp.json` inside a workspace and remove the `agentdeploy` entry. Claude Code re-reads the config on each run. You'd lose the Deployments page for that session but nothing else breaks.

To disable it globally, you'd modify the workspace image. Not something we expose via configuration today because nobody's asked.
