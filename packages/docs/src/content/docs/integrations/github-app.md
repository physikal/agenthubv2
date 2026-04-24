---
title: GitHub App
description: One-click GitHub integration for all coding sessions — per-repo scoped, auto-rotating tokens, revocable instantly.
---

AgentHub ships a GitHub App-based integration that replaces per-user Personal Access Tokens with click-to-install, per-repo authorization. Every new coding session that starts for a user with an active installation gets a fresh 1-hour GitHub token wired into `~/.gitconfig` automatically — `git clone`, `git push`, and the `push_to_github` MCP tool all "just work" without the user managing credentials.

## What it gives you vs. a PAT

| | GitHub App | Personal Access Token |
|---|---|---|
| **Scope** | Per-repo (user picks which ones AgentHub sees) | Everything the token's scopes allow |
| **Lifetime** | 1-hour installation tokens, auto-minted per session | Long-lived, user-rotated |
| **Revocation** | Instant — uninstall on GitHub, all sessions lose access | Delete the token in GitHub; AgentHub doesn't know until next call |
| **Setup UX** | One-click install, visual repo picker on github.com | User creates token, pastes into form, manages scopes |
| **Repo creation** | ❌ not supported (needs `administration:write`, we don't request it) | ✅ if the token has `administration:write` |

For almost every workflow the App is the right choice. Keep the PAT form for repo creation (`push_to_github` creating a new repo) or for legacy installs where the App isn't registered.

## Admin setup (one-time)

Only someone with admin role on this AgentHub install does this, and only once per install.

**Prerequisite:** GitHub's servers need to reach `/api/admin/github-app/manifest-callback` and `/api/integrations/github/webhook` at the URL you're accessing AgentHub through — so you need a public HTTPS URL in the browser's address bar when you click Register. The manifest picks up whatever origin you're on, so a tunnel (Cloudflare Tunnel, ngrok) pointed at a localhost install is enough; you don't need to reinstall or change `DOMAIN` in compose. A hard-localhost browser URL can't register at all — GitHub will reject the manifest.

1. Log in as admin. **Access AgentHub via your public URL** (tunnel or real domain — don't register from `https://localhost`). Go to **Integrations** → "GitHub App" card → **Register GitHub App**.
2. Your browser is redirected to github.com with a pre-filled manifest. The App's name is `AgentHub (<your-domain>)` by default.
3. Choose the account you want to **own** the App (your personal GitHub account or an org you admin) and click **Create GitHub App**.
4. GitHub redirects back to AgentHub. You'll see `GitHub App registered` in a green banner and the card will show the App name + ID.

The App's private key and webhook secret are stored in Infisical at `/system/github-app/` — never on disk, never returned by any API.

### Re-registering or rotating keys

Admins see a **Re-register** link in the GitHub App card footer once the App is registered. GitHub will show the same manifest flow and issue a fresh private key. AgentHub overwrites the old credentials atomically. Any existing user installations keep working (they reference installation IDs, not the App's own keys).

### Unregistering

Same footer, **Unregister** link. This removes AgentHub's knowledge of the App. It does **not** delete the App on GitHub's side — you must do that at `github.com/settings/apps/<slug>` if you want to fully tear down. Re-registering with the same domain will create a new App under a new slug.

## User setup (per GitHub account)

1. Go to **Integrations** → "GitHub App" card → **Install on GitHub**.
2. GitHub asks which account to install on (your personal account or an org you admin). Pick one.
3. Pick repo scope: **All repositories** or **Only select repositories**. For narrower blast radius, use "Only select" and list the repos AgentHub should see.
4. Click **Install**.
5. GitHub redirects back. The card now shows the account login, account type (user/org), and `Selected repos` or `All repos`.

You can install on multiple accounts (your personal + an org). Each appears as a separate row. You can also re-visit the install page on GitHub to add/remove repos — AgentHub picks up the changes the next time you land on `/integrations` via GitHub's redirect.

## What happens in a session

When you start a session, AgentHub:

1. Mints a fresh 1-hour installation token for your first active install.
2. Injects `GITHUB_TOKEN` and `GITHUB_ACCOUNT_LOGIN` into the workspace's environment.
3. The in-container agent writes `~/.gitconfig` (mode 0600) with:
    - A `url.https://x-access-token:<token>@github.com/.insteadOf = https://github.com/` rule so every HTTPS GitHub URL picks up the token.
    - A `credential.helper` fallback for tools (like `gh`) that bypass the URL rewrite.
    - `user.name` and `user.email` seeded from your GitHub login.

`git clone`, `git push`, and `gh` all authenticate transparently. `gh auth status` will report the install as authenticated — agents won't nag you to run `gh auth login`.

### Token lifetime

Installation tokens last 1 hour. Sessions shorter than 1 hour work fine. Longer sessions currently require a session restart to re-mint — an automatic refresh loop is a known follow-up.

### When the App isn't enough

`push_to_github` needs `administration:write` to create a new repo, which the AgentHub App deliberately doesn't request (it would trigger admin approval in most orgs and widens blast radius). If you ask it to push to a repo that doesn't exist, you'll get a clear error telling you to either create the repo on github.com first or add a Personal Access Token integration. Pushes to existing repos work fine.

## Troubleshooting

**"GitHub App not registered"** when installing. An admin hasn't completed the admin setup above yet. Poke them.

**Manifest callback shows `exchange_failed`.** GitHub returned an error when AgentHub tried to exchange the temporary code for App credentials. Common causes: the manifest was already consumed (code is single-use, 1-hour TTL); network reachability from your AgentHub to `api.github.com` is blocked. Check server logs for the `[github-app]` line with the raw GitHub error body.

**Manifest callback shows `state_expired`.** You took more than 15 minutes between clicking Register and approving on GitHub. Re-click Register; a fresh state token will be issued.

**Installation completes on GitHub but AgentHub shows no install.** Check that your AgentHub's public URL is actually reachable from the internet. GitHub POSTs to `/api/integrations/github/callback`; if that's unreachable, the install is orphaned. Re-installing from AgentHub's side (`/integrations` → Install on GitHub) re-triggers the round trip.

**Webhooks aren't updating suspended/deleted badges.** AgentHub doesn't require webhooks to be load-bearing — lazy 401 detection on the next token mint will mark the install. If you want faster feedback, confirm `https://<your-domain>/api/integrations/github/webhook` is reachable externally (test with `curl -X POST` and expect a 401 for unsigned requests).

**`git push` fails in a workspace with "Authentication failed".** The token in `~/.gitconfig` likely expired (1-hour lifetime). End the session and start a new one — the fresh session will get a fresh token.

## Security model

- **Private key.** RS256 PEM, stored in Infisical at `/system/github-app/privateKey`. Never returned by any route. Used only to sign short-lived JWTs (10-minute exp, passed once to GitHub's `/app/installations/:id/access_tokens`, never stored).
- **Webhook secret.** HMAC-SHA256 shared with GitHub. Every webhook delivery is verified over the raw body using `timingSafeEqual` before any JSON parsing.
- **Installation tokens.** Minted on demand; never persisted. Cached in-process for their 1-hour lifetime by `@octokit/auth-app`.
- **`~/.gitconfig`.** Mode 0600, owned by the coder user (uid 1000). Overwritten on every session boot; regenerated on token refresh (when that lands).
- **CSRF.** The admin manifest flow and the user install flow both use 32-byte random state tokens, single-use (marked `usedAt` on exchange), 15-minute TTL. In addition, `GET /api/admin/github-app/register` requires `Sec-Fetch-Site` to be same-origin (with an `Origin`/`Referer` host-match fallback for pre-Fetch-Metadata clients) and rejects any `origin` query param whose host differs from the request host. This closes a cross-site request that would otherwise trick an admin's browser into submitting a manifest with an attacker-controlled `redirect_url`, letting the attacker exchange the one-time code for the App's private key + webhook secret.
- **Origin param validation.** `validateOrigin` accepts only `http:`/`https:` URLs and normalizes them to `${protocol}//${host}` before building the manifest — prevents `javascript:` / `file:` / malformed URLs from reaching GitHub's form post.
- **`AGENT_TOKEN` not in backups.** The per-session bearer stored in `~/.agenthub-env` is excluded from B2 rclone save + restore. The file is regenerated on every session boot, so there's no value in backing it up and every downside (a bucket-key holder could otherwise recover a session token).
- **Least-privilege scope.** The App requests `contents:write` + `metadata:read` only. Orgs can install without admin approval.
