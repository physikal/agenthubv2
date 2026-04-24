import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Hono } from "hono";
import type { AgentSessionContext, AuthUser } from "../middleware/auth.js";
import { createRepoIfMissing, loadGitHubCreds } from "../services/providers/github.js";
import { mintTokenForUserWithExpiry } from "../services/providers/github-app.js";

const execFileAsync = promisify(execFile);

/**
 * Server-side helper that lets the agent push its workspace source to
 * GitHub. Two auth paths, chosen by loadGitHubCreds:
 *
 *   - github-app: the session already has GITHUB_TOKEN in its env and a
 *     ~/.gitconfig url-rewrite rule written by the agent at boot. We just
 *     run git against `https://github.com/<full-name>.git` — credentials
 *     flow through the existing workspace setup, no per-invocation
 *     secret injection needed.
 *   - pat: legacy path — bake the PAT into the remote URL for this one
 *     push, strip it from .git/config afterwards so it doesn't get
 *     persisted alongside the user's code.
 *
 * createRepoIfMissing still uses whichever bearer we have. App-source
 * creds lack administration:write (per the App manifest in Phase 2), so
 * if the caller asks us to create a missing repo we surface a clear 400
 * instead of letting GitHub's 403 bubble up uninterpreted.
 */
export function agentGithubRoutes() {
  const app = new Hono<{
    Variables: { user: AuthUser; agentSession?: AgentSessionContext };
  }>();

  // GET /api/agent/github/token — credential-helper endpoint. The workspace's
  // git-credential-agenthub script hits this per git operation; we mint (or
  // reuse the cached) GitHub App installation token server-side and return
  // it to the helper, which pipes it into git's auth negotiation. The token
  // itself never lands on disk inside the workspace and never exists in any
  // long-lived env var — a full octokit round-trip's latency (~1ms when
  // cached, low tens of ms on a fresh mint) for each `git clone`/`push` is
  // the cost. Auth-app's in-process cache keeps the GitHub-side load
  // negligible even under heavy workspace activity.
  app.get("/token", async (c) => {
    const user = c.get("user");
    try {
      const result = await mintTokenForUserWithExpiry(user.id);
      if (!result) {
        return c.json({ error: "no-github-app-install" }, 404);
      }
      return c.json({
        token: result.token,
        expiresAt: result.expiresAt,
        accountLogin: result.accountLogin,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 502);
    }
  });

  app.post("/push", async (c) => {
    const user = c.get("user");
    const session = c.get("agentSession");
    if (!session?.workspaceId) {
      return c.json({ error: "push requires an agent session" }, 400);
    }

    const body = await c.req.json<{
      path: string;
      repo: string;
      private?: boolean;
      commitMessage?: string;
      description?: string;
    }>();

    if (!body.path || !/^\/home\/coder\/[a-zA-Z0-9._\-/]+$/.test(body.path)) {
      return c.json({ error: "path must be an absolute path under /home/coder" }, 400);
    }
    if (!body.repo || !/^[a-zA-Z0-9._-]{1,100}$/.test(body.repo)) {
      return c.json({ error: "repo must match [A-Za-z0-9._-]{1,100}" }, 400);
    }

    const creds = await loadGitHubCreds(user.id);
    if (!creds) {
      return c.json(
        {
          error:
            "GitHub integration not configured. Add one in Integrations with a PAT that has contents:write + administration:write.",
        },
        400,
      );
    }

    let repo;
    try {
      const opts: { private: boolean; description?: string } = {
        private: body.private ?? false,
      };
      if (body.description) opts.description = body.description;
      repo = await createRepoIfMissing(creds, body.repo, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // App-sourced creds can't create repos — surface a specific error so
      // the agent can tell the user to either create the repo on github.com
      // first or add a PAT with administration:write. Everything else stays
      // as an upstream 502.
      if (creds.source === "github-app" && /\b403\b/.test(msg)) {
        return c.json(
          {
            error: `GitHub App can't create repos (no administration:write). Create "${body.repo}" on github.com first, or add a Personal Access Token integration with administration:write.`,
          },
          400,
        );
      }
      return c.json({ error: `Could not create repo: ${msg}` }, 502);
    }

    // Push from the workspace container. Two flavors:
    //   - github-app: the session's ~/.gitconfig already has a url-rewrite
    //     rule injecting the installation token. Plain `https://github.com/
    //     <owner>/<repo>.git` resolves through it.
    //   - pat: inject the PAT into the remote URL for this one push, strip
    //     it after so it doesn't persist in .git/config.
    const containerName = `agenthub-ws-${session.workspaceId}`;
    const plainUrl = `https://github.com/${repo.fullName}.git`;
    const remoteUrl =
      creds.source === "github-app"
        ? plainUrl
        : `https://x-access-token:${creds.pat}@github.com/${repo.fullName}.git`;
    const commitMsg = body.commitMessage ?? "Initial commit";
    // Pass commit message + remote URLs through `docker exec -e` env vars
    // instead of interpolating them into the bash -c script. Bash expands
    // "$VAR" by literal substitution — it does NOT re-parse the expansion
    // for $(...) / backticks, so an attacker-controlled commit message
    // can't turn into command substitution. `body.path` is regex-validated
    // upstream; inlining it is safe.
    const steps = [
      `cd ${JSON.stringify(body.path)}`,
      "git init -b main 2>/dev/null || true",
      "git config user.email 'agenthub@users.noreply.github.com'",
      "git config user.name 'AgentHub'",
      "git add -A",
      'git diff --cached --quiet || git commit -m "$COMMIT_MSG"',
      "git remote remove origin 2>/dev/null || true",
      'git remote add origin "$REMOTE_URL"',
      "git branch -M main",
      "git push -u origin main",
    ];
    if (creds.source === "pat") {
      // Strip the PAT-bearing remote so it doesn't persist on disk.
      steps.push('git remote set-url origin "$PLAIN_URL"');
    }
    const script = steps.join(" && ");

    const dockerArgs = ["exec", "-e", "COMMIT_MSG", "-e", "REMOTE_URL"];
    if (creds.source === "pat") dockerArgs.push("-e", "PLAIN_URL");
    dockerArgs.push(containerName, "bash", "-lc", script);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      COMMIT_MSG: commitMsg,
      REMOTE_URL: remoteUrl,
    };
    if (creds.source === "pat") childEnv["PLAIN_URL"] = plainUrl;

    try {
      const { stdout, stderr } = await execFileAsync(
        "docker",
        dockerArgs,
        { env: childEnv, timeout: 60_000 },
      );
      return c.json({
        repo: repo.fullName,
        cloneUrl: `https://github.com/${repo.fullName}.git`,
        branch: "main",
        stdout: stdout.slice(-1_000),
        stderr: stderr.slice(-1_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `git push failed: ${msg.slice(0, 1_000)}` }, 500);
    }
  });

  return app;
}
