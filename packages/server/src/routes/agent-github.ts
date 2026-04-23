import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Hono } from "hono";
import type { AgentSessionContext, AuthUser } from "../middleware/auth.js";
import { createRepoIfMissing, loadGitHubCreds } from "../services/providers/github.js";

const execFileAsync = promisify(execFile);

/**
 * Server-side helper that lets the agent push its workspace source to
 * GitHub without teaching the agent about PATs. The agent calls the
 * `push_to_github` MCP tool → MCP posts here with {path, repo} →
 * server resolves the user's GitHub PAT from Infisical, creates the
 * repo if needed, then `docker exec`'s into the caller's workspace
 * container to run git + gh with GH_TOKEN injected at command time
 * (never written to disk inside the workspace).
 */
export function agentGithubRoutes() {
  const app = new Hono<{
    Variables: { user: AuthUser; agentSession?: AgentSessionContext };
  }>();

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
      return c.json({ error: `Could not create repo: ${msg}` }, 502);
    }

    // Push from the workspace container. GH_TOKEN reaches `gh` via docker
    // exec's -e flag; never touches the container's filesystem.
    const containerName = `agenthub-ws-${session.workspaceId}`;
    const authedUrl = `https://x-access-token:${creds.pat}@github.com/${repo.fullName}.git`;
    const commitMsg = body.commitMessage ?? "Initial commit";
    const script = [
      `cd ${JSON.stringify(body.path)}`,
      "git init -b main 2>/dev/null || true",
      "git config user.email 'agenthub@users.noreply.github.com'",
      "git config user.name 'AgentHub'",
      "git add -A",
      // No-op if nothing to commit.
      `git diff --cached --quiet || git commit -m ${JSON.stringify(commitMsg)}`,
      `git remote remove origin 2>/dev/null || true`,
      `git remote add origin ${JSON.stringify(authedUrl)}`,
      "git branch -M main",
      "git push -u origin main",
      // Strip the PAT from the stored remote URL so it doesn't leak into
      // .git/config for the user to see or back up.
      `git remote set-url origin https://github.com/${repo.fullName}.git`,
    ].join(" && ");

    try {
      const { stdout, stderr } = await execFileAsync(
        "docker",
        ["exec", containerName, "bash", "-lc", script],
        { timeout: 60_000 },
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
