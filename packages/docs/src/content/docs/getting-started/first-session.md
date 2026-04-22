---
title: Your first session
description: From login to a working Claude Code prompt in under five minutes.
---

This is the fast path. It assumes the install finished without errors — if something's on fire, head to [Troubleshooting](/docs/operators/troubleshooting/) first.

## 1. Log in

Browse to the URL the installer printed (e.g. `http://localhost` or `https://your-domain.example.com`). You'll see the AgentHub login.

- **Username:** `admin`
- **Password:** whatever the installer printed, also in `compose/.env` as `AGENTHUB_ADMIN_PASSWORD`

Go to **Settings → Change Password** and set your own password before doing anything else. The random one is not meant to stick around.

## 2. Create a session

Click **My Sessions** in the sidebar, then **+ New session**. You get a short form:

| Field | What it does |
|---|---|
| **Name** | Display name for the session in the sidebar. Required. |
| **Repo** (optional) | A git URL. If set, the workspace clones it to `~/repo` on first boot. |
| **Prompt** (optional) | A starting prompt. The agent daemon drops it into `~/.prompt` for you to pipe into whichever CLI you launch. |

Click **Create**. The row lights up with status `creating` → `starting` → `active`. That takes 5–15 seconds on local Docker mode; longer if the workspace image is being pulled from the registry for the first time.

## 3. Open the terminal

Click the session row. The right pane opens an xterm.js terminal attached to a persistent shell inside the workspace container. Your prompt looks like:

```console
coder@agenthub-ws-a1b2c3:~$
```

You are the `coder` user (uid 1000, passwordless sudo). `/home/coder` is your home; it's a Docker volume that survives session end.

## 4. Talk to Claude Code

```bash
claude
```

On first run, Claude Code will print a URL and a one-time code for signing in with your Anthropic account. Paste the code into your browser, authorize, and you land in a chat prompt.

From there:

```
> write me a hello-world fastify server in /tmp/server
```

Claude Code will read, write, and exec inside the workspace. You can switch models mid-session:

```
/model claude-opus-4-7
```

See the [Claude Code CLI page](/docs/clis/claude-code/) for the AgentHub-specific details (pre-set env vars, where the cache lives, etc.).

## 5. Preview a web server

If your agent starts a web server on, say, port 3000:

```bash
preview :3000
```

prints a URL like `https://your-host/api/sessions/{id}/preview/port/3000/` that you can open from your laptop browser. The URL lives only as long as the session, and only you can reach it (cookie-authed). See [Supporting tools](/docs/clis/supporting-tools/) for the full `preview` reference.

## 6. Persistence you can rely on

- **Close the browser tab.** The shell keeps running inside the container. Reopen the session, your history is intact.
- **End the session.** The container is torn down but `/home/coder` is kept on its volume. A new session restores the same files.
- **Restart the host.** `docker compose up -d` brings everything back, including your volumes.

The one thing that wipes `/home/coder` is **deleting the user** in the admin Users page. That intentionally purges the volume.

## Next

- Different agent? See [Agent CLIs · overview](/docs/clis/overview/).
- Want the agent to deploy its work? See [agentdeploy MCP](/docs/agentdeploy/overview/).
- Back up your files? Set up [Backups](/docs/web-ui/backups/) after you configure a [Backblaze B2 integration](/docs/web-ui/integrations/).
