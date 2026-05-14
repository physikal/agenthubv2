# Disaster recovery

How to get back to a working AgentHub install — same VM (revert a bad
change) or fresh VM (migrate / replace a dead host) — using the bundled
backup tools.

## What's preserved by AgentHub's design

These keep working without any operator action, as long as the user
data layer is intact:

| Surface | How it survives |
|---|---|
| Sessions for the same user across new containers | `agenthub-home-{userId}` Docker volume mounts at `/home/coder` in every session. Files written in session N are visible in session N+1 on the same install. |
| GitHub auth inside sessions (`gh`, `git push`) | Server-side credential helper mints short-lived installation tokens per request. Nothing on disk in the workspace. |
| Provider API keys (Anthropic / OpenAI / MiniMax / Cloudflare / B2 / DigitalOcean / Dokploy) | Stored in Infisical, restored verbatim by `agenthub restore-install`. |
| AI CLI auth (`claude`, `codex`) when `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` is set | Env-injected into every session container at create time. **This is the recommended path** — see [Auth strategy](#auth-strategy) below. |

These DON'T survive automatically and require explicit recovery steps:

| Surface | Recovery |
|---|---|
| Users, their sessions history, infrastructure configs | `agenthub restore-install` |
| Per-user `/home/coder` contents (git checkouts, dotfiles, shell history) | `agenthub restore-workspace --user <name>` |
| OAuth tokens stored on disk by interactive `claude auth login` / `codex login` | May or may not survive cross-VM — depends on provider device-binding. See [Auth strategy](#auth-strategy). |

## Same-VM rollback (the easy case)

After a bad `agenthub update`:

```bash
# List local install backups (the auto-backup runs before every update)
sudo ls -lt /data/install-backups/*.tar.gz | head -5

# Restore the most recent
sudo agenthub restore-install --snapshot latest --force
```

The restore happens in a temporary container so it can replace `.env`,
SQLite, and Infisical Postgres while the live stack restarts cleanly.
Workspace volumes are untouched.

## Cross-VM recovery (dead host, replacing hardware, migrating cloud)

This assumes you've already been pushing backups to Backblaze B2 (or any
[supported rclone backend](install-backup.md#configure-b2-storage)).

### 1. Install AgentHub on the new VM

Run the one-liner from the [README](../../README.md). Use the same
`DOMAIN` you had before if possible — it makes Cloudflare DNS / TLS
reuse simpler. If you have to change domain, you'll need to update
DNS + redo any external integrations that pointed at the old hostname.

### 2. Configure backup storage on the new VM

Settings → Admin → Install Backup → enter the same B2 credentials +
bucket + path prefix you used on the old VM. Click **Test connection**.
Once green:

```bash
# List remote bundles
sudo agenthub restore-install --snapshot latest --dry-run
```

The dry-run reports any conflicts (existing users, active sessions,
encryption-key mismatch).

### 3. Restore the install state

```bash
sudo agenthub restore-install --snapshot latest
```

This pulls the latest install bundle from B2, replaces `.env`,
restores SQLite + Infisical Postgres, and brings the stack back up.
Takes 1-3 minutes for a typical install.

After this completes:
- Users, infrastructure configs, GitHub App install, etc. are all back.
- Provider API keys in Infisical are back.
- **Workspace volumes are still empty** — restore them next.

### 4. Restore each user's workspace

```bash
# Per user:
sudo agenthub restore-workspace --user alice --snapshot latest

# Or list available workspaces if you forget who:
sudo agenthub backup-workspace --all --local-only --note "pre-restore-list"  # local-only side-effect: scans
```

The restore refuses if the user already has an active session — end
their sessions first. With `--force`, the existing workspace volume is
removed and recreated from the bundle (destructive — old data lost).

### 5. Verify

- Log in as each user. Open a session. The terminal opens in
  `/home/coder` with the user's files restored.
- `gh auth status` should report logged in.
- `echo $ANTHROPIC_API_KEY` should print the first few characters of
  the key.
- `claude --version` should run without prompting to log in (if you
  use the API-key path — see below).

## Auth strategy

The bundled CLIs (`claude`, `codex`, `gh`) need auth tokens. AgentHub
offers two paths; pick one consistently across users:

### Path A — API keys via Infisical (recommended)

1. Go to **Integrations** → **Add provider** for each AI provider you
   use (Anthropic / OpenAI / MiniMax).
2. Paste the API key. Click **Verify** — AgentHub makes a real API
   call to confirm the key is good.
3. From this point on, every session container has `ANTHROPIC_API_KEY`
   / `OPENAI_API_KEY` / `MINIMAX_API_KEY` env-injected at create time.

Why this is recommended:
- Cross-VM restore works automatically — Infisical is in the install
  backup bundle.
- No interactive auth flow needed for new users.
- Easy to rotate (update the Integration, all sessions pick up the
  new key on next create).
- Easy to revoke (remove the Integration, kill sessions).

### Path B — Interactive `claude auth login` / `codex login`

Inside a session terminal, run `claude auth login` and follow the
OAuth flow. The CLI stores tokens at `~/.claude/credentials.json`
(or similar path).

Same-VM continuity: persists across sessions (the volume keeps the
token file).

Cross-VM continuity: **unreliable**. Providers may bind OAuth tokens
to a device fingerprint or revoke them on transfer. AgentHub backs
up and restores the on-disk token file byte-identical, but whether
the provider still honours it on a new VM is the provider's
decision.

If you need cross-VM continuity, prefer Path A.

## What if the new VM has a different hostname?

Set `AGENTHUB_DOMAIN=<new-host>` when running the install one-liner.
After the install:

```bash
# Update Cloudflare records (if you use the Cloudflare integration) by
# editing the relevant Integration in Settings.

# Anything that hardcoded the old hostname (external webhooks pointing
# at /api/github/webhook, OAuth callback URLs for GitHub Apps) needs
# re-pointing manually. Check Integrations → GitHub for the URLs to
# update.
```

## What if I lost the B2 credentials too?

If you can still log in to your old install:

```bash
# Reveal the B2 application key (admin-only, gated by AgentHub password):
# Settings → Admin → Install Backup → B2 Configuration → Reveal
```

If you can't log in to the old install but have shell on it:

```bash
sudo docker exec agenthub-agenthub-server-1 \
  node --input-type=module <<'EOF'
import { loadB2Config } from "/app/packages/server/dist/services/install-backup/runner.js";
console.log(await loadB2Config());
EOF
```

If both are gone: your last operator-side options are (a) a local-only
bundle copy (if you had it scp'd off the box), or (b) per-user volume
data via direct `docker volume inspect` access on the failed host.

## Bundle encryption status

Both install and workspace bundles are written **unencrypted**.
Security relies on B2 bucket ACLs and filesystem permissions on
`/data/install-backups/` and `/data/workspace-backups/`. If a host or
B2 key is compromised, treat every secret in `compose/.env` and every
user's `/home/coder` as potentially exfiltrated.

Opt-in encryption is on the roadmap.
