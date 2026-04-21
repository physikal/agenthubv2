# Container Preview System

Preview media files, dev server UIs, and static HTML from LXC session containers in the browser.

## Problem

Containers are terminal-only. When a user generates a video with `mmx`, an image with an AI tool, or runs a dev server, there's no way to view the output — it sits on the container filesystem unreachable from the browser. The containers are on a private LAN (192.168.5.x) so the browser can't reach them directly.

## Solution

An authenticated HTTP proxy through the AgentHub server, triggered by clickable URLs printed in the terminal.

## User Experience

```bash
# User generates a video inside their container
$ mmx video generate --prompt "a cat" -o ~/cat.mp4

# User runs the preview command
$ preview ~/cat.mp4
  → https://agenthub.physhlab.com/api/sessions/abc-123/preview/file/home/coder/cat.mp4

# User clicks the link in xterm → new browser tab opens → video plays
```

```bash
# User starts a dev server
$ npm run dev
  Local: http://localhost:5173/

# User previews the port
$ preview :5173
  → https://agenthub.physhlab.com/api/sessions/abc-123/preview/port/5173/

# User clicks → new tab opens → full interactive web app
```

## Architecture

```
User's Browser                  Hono Server                    LXC Container
(new tab)                       (agenthub.physhlab.com)        (192.168.5.x)
     │                                │                              │
     │  GET /api/sessions/:id/        │                              │
     │      preview/file/...    ────► │  1. Cookie auth              │
     │                                │  2. Verify session owner     │
     │                                │  3. Resolve container IP     │
     │                                │  4. Proxy to container ────► │
     │                                │                              │  Agent file
     │                                │  ◄──── stream response ──── │  server :9877
     │  ◄──── stream to browser ──── │                              │
     │                                │                              │
     │  GET /api/sessions/:id/        │                              │
     │      preview/port/5173/  ────► │  Same auth flow              │
     │                                │  Proxy to :5173 ──────────► │  Dev server
     │  ◄──── full HTTP response ─── │  ◄──── response ─────────── │  on :5173
```

## URL Scheme

| Pattern | Purpose | Proxied To |
|---------|---------|------------|
| `/api/sessions/:id/preview/file/{path}` | Media files, HTML, PDFs | Agent file server at `container:9877/{path}` |
| `/api/sessions/:id/preview/port/{port}/{path}` | Dev server UIs | `container:{port}/{path}` |

## Components

### 1. Agent File Server (new)

**Location:** `packages/agent/src/file-server.ts`

A lightweight HTTP server on port 9877 inside each container that serves files from the filesystem.

- Serves files with correct MIME types (video/mp4, image/png, text/html, etc.)
- Streams large files — does not buffer entire files in memory
- No directory listing — returns 404 for directories
- Runs as `coder` user (same file permissions the user has)
- Only accessible from private LAN (not exposed externally)
- Started by the existing `agenthub-agent.service` systemd unit (the agent entry point starts both the WebSocket server and the file server)

### 2. Server Proxy Route (new)

**Location:** `packages/server/src/routes/preview.ts`

Mounted at `/api/sessions/:id/preview/*` in the Hono app.

**File proxy (`/preview/file/*`):**
- Existing cookie auth middleware
- Verify requesting user owns the session (session.userId === user.id)
- Fetch from `http://{container-ip}:9877/{filepath}`
- Stream response back with original Content-Type
- No caching headers (files may change between requests)

**Port proxy (`/preview/port/:port/*`):**
- Same auth check
- Proxy full HTTP request to `http://{container-ip}:{port}/{path}`
- Pass through query strings, request body, headers
- Rewrite `Location` headers on redirects to stay within the proxy
- WebSocket upgrade support for HMR (Vite, Next.js dev servers)
- Follow the same WebSocket upgrade pattern as `packages/server/src/ws/terminal-proxy.ts`

### 3. `preview` CLI Tool (new)

**Location:** Installed at `/usr/local/bin/preview` in the LXC template

A bash script that constructs and prints the preview URL. Relies on two env vars:
- `AGENTHUB_SESSION_ID` — session UUID
- `AGENTHUB_URL` — server base URL (e.g., `https://agenthub.physhlab.com`)

```bash
preview ~/output.mp4           # → file preview URL
preview :5173                  # → port preview URL
preview /home/coder/index.html # → file preview URL
```

Prints the clickable URL to stdout. xterm's `addon-web-links` (already installed) makes it clickable in the terminal.

### 4. Session Manager Changes

**Location:** `packages/server/src/services/session-manager.ts`

During `provisionAndStart()`, write a `~/.agenthub-env` file to the user's persistent home:

```bash
export AGENTHUB_SESSION_ID="abc-123-def-456"
export AGENTHUB_URL="https://agenthub.physhlab.com"
```

Written with the same pattern as existing config writes (mkdirSync, writeFileSync, chownSync 101000:101000).

### 5. Template Changes

**Location:** `infra/lxc-template.sh`

- Install `/usr/local/bin/preview` script
- Install `/etc/profile.d/agenthub-preview.sh` that sources `~/.agenthub-env` on login:
  ```bash
  [ -f /home/coder/.agenthub-env ] && . /home/coder/.agenthub-env
  ```
- Agent file server port 9877 is started by the agent process (no separate systemd unit needed)

## Security

- **Authentication:** Cookie auth on every proxy request (existing middleware)
- **Authorization:** Session ownership check — only the user who created the session can preview its content
- **No directory listing:** The file server returns 404 for directory paths
- **Private LAN only:** Container ports (9877, dev servers) are only reachable from the private network, never directly from the internet
- **Path traversal prevention:** The agent file server resolves paths with `realpath` and validates the result is under `/home/coder` or `/tmp` — blocks `../` traversal and symlink escapes

## Files to Create or Modify

| File | Action | Purpose |
|------|--------|---------|
| `packages/agent/src/file-server.ts` | Create | HTTP file server (port 9877) |
| `packages/agent/src/index.ts` | Modify | Start file server alongside WebSocket server |
| `packages/server/src/routes/preview.ts` | Create | Proxy route for files and ports |
| `packages/server/src/index.ts` | Modify | Mount preview route |
| `packages/server/src/services/session-manager.ts` | Modify | Write env vars for preview CLI |
| `infra/lxc-template.sh` | Modify | Install preview CLI + profile.d script |

## Not In Scope

- Split-panel preview embedded in the session page (future enhancement — same proxy infra)
- Auto-detection of file creation or port listening (future — start with explicit `preview` command)
- File browser / directory listing (explicitly excluded)
- Thumbnail generation or media transcoding
