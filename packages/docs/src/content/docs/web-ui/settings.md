---
title: Settings
description: Your account, password, and (for admins) the Version + Update panel.
---

**Settings** is where you manage your own AgentHub account and, if you're an admin, the install itself.

## Account

- **Display name** — optional label shown in the sidebar and in the user list.
- **Username** — your login handle. Not editable post-creation.
- **Email** — optional, informational only (no email is ever sent by AgentHub; this is for your own records).

## Change password

Standard current-password + new-password + confirm form. Minimum 8 characters, no other rules enforced (the hashing is bcrypt with a sane cost factor, so a long passphrase is the sensible move).

Change your password on first login. The installer-generated admin password is not meant to stick around.

## Version panel (admin only)

At the bottom of the page, admins see a **Version** panel. It displays:

- **Current commit** — the SHA your install is running, with short message.
- **Latest on `origin/main`** — the latest commit in the upstream repo, fetched live.
- **Pending commits** — the list of commits between yours and upstream, with author + message.

If **Pending commits** is non-empty, the **Update now** button is live.

### Update now

Clicking **Update now** spawns a one-shot `agenthubv2-updater:local` container that:

1. `git pull` inside the repo mount (`/repo` in the server container).
2. `docker build` any images whose source changed.
3. `docker compose up -d` to land config drift.
4. `docker compose up -d --force-recreate agenthub-server` with the new image.
5. Runs any pending DB migrations.
6. Exits.

The server reboots during step 4, so the UI briefly disconnects. It reconnects once the new server is healthy; the page auto-reloads.

Same code path as `agenthub update` from the host shell — both spawn the same updater image, so fixes land identically no matter which trigger you use.

See [Updates](/docs/operators/updates/) for the failure modes.

## Where this data lives

- **Account fields** — SQLite `users` table.
- **Password** — `users.password_hash` (bcrypt).
- **Version info** — fetched live from git, not stored.

## Things the Settings page doesn't do

- **Delete your account.** That's an admin-only operation on the Users page. Self-delete isn't exposed (too easy to foot-gun).
- **Manage your sessions.** See the [Sessions page](/docs/web-ui/sessions/).
- **Manage other users.** Admin → Users.

## Logging out

The **Logout** button is in the sidebar footer. It clears your `session_token` cookie and the in-memory auth store. Workspace containers are left running — your home volume is untouched.
