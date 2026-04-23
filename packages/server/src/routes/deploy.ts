import { Hono } from "hono";
import { eq, and, not } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { AgentSessionContext, AuthUser } from "../middleware/auth.js";
import {
  deploy,
  getDeploymentLogs,
  restartDeployment,
  destroyDeployment,
} from "../services/deployer.js";
import {
  ensureGitHubPagesInfra,
  ensureLocalDockerInfra,
} from "../services/local-docker-seed.js";

interface DeployBody {
  name: string;
  domain?: string;
  internalOnly?: boolean;
  sourcePath?: string;
  composeConfig?: string;
  composePath?: string;
  gitUrl?: string;
  gitBranch?: string;
  envVars?: Record<string, string>;
  database?: "none" | "sqlite" | "postgres";
  infraName?: string;
  dnsName?: string;
}

// Conservative: HTTPS only, host label charset only, no path traversal.
// Covers github.com, gitlab.com, self-hosted GitLab/Gitea; rejects ssh,
// file://, and anything with shell metacharacters.
const GIT_URL_RE = /^https:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?\/[A-Za-z0-9._\-\/]{1,255}(?:\.git)?$/;
const GIT_BRANCH_RE = /^[A-Za-z0-9._\-\/]{1,255}$/;

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_VARS = 100;
const MAX_ENV_VALUE_LEN = 4096;

export function deployRoutes() {
  const app = new Hono<{
    Variables: { user: AuthUser; agentSession?: AgentSessionContext };
  }>();

  // POST /api/deploy — start a new deployment
  app.post("/", async (c) => {
    const user = c.get("user");
    const body = await c.req.json<DeployBody>();

    if (!body.name) {
      return c.json({ error: "name required" }, 400);
    }

    const sourceModes = [body.sourcePath, body.composeConfig, body.gitUrl].filter(Boolean).length;
    if (sourceModes === 0) {
      return c.json({ error: "One of sourcePath, composeConfig, or gitUrl is required" }, 400);
    }
    if (sourceModes > 1) {
      return c.json({ error: "sourcePath, composeConfig, and gitUrl are mutually exclusive" }, 400);
    }

    if (body.gitUrl && !GIT_URL_RE.test(body.gitUrl)) {
      return c.json(
        { error: "gitUrl must be an https Git URL (e.g. https://github.com/owner/repo.git)" },
        400,
      );
    }
    if (body.gitBranch && !GIT_BRANCH_RE.test(body.gitBranch)) {
      return c.json({ error: "gitBranch has invalid characters" }, 400);
    }

    // Validate name (alphanumeric + hyphens only)
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.name)) {
      return c.json(
        { error: "name must be lowercase alphanumeric with hyphens, 1-63 chars" },
        400,
      );
    }

    // Validate sourcePath if provided — prevent command injection and path traversal
    if (body.sourcePath && (!/^\/home\/coder\/[a-zA-Z0-9._\-\/]+$/.test(body.sourcePath) || body.sourcePath.includes(".."))) {
      return c.json(
        { error: "sourcePath must be an absolute path under /home/coder/ with no special characters" },
        400,
      );
    }

    // Validate domain if provided
    if (body.domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(body.domain)) {
      return c.json({ error: "domain must be a valid hostname" }, 400);
    }

    // Validate composePath — relative path under the source dir, no ..
    if (body.composePath) {
      if (
        !/^[a-zA-Z0-9._\-\/]+$/.test(body.composePath) ||
        body.composePath.includes("..") ||
        body.composePath.startsWith("/")
      ) {
        return c.json(
          { error: "composePath must be a relative path under sourcePath (letters, digits, dots, underscores, hyphens, slashes)" },
          400,
        );
      }
    }

    // Validate envVars shape — capped, keys are conventional env-var format,
    // values bounded in length. Prevents a pathological payload blowing up
    // the .env file or smuggling unexpected keys into Docker Compose's
    // variable substitution.
    if (body.envVars) {
      if (typeof body.envVars !== "object" || Array.isArray(body.envVars)) {
        return c.json({ error: "envVars must be an object of string key/values" }, 400);
      }
      const keys = Object.keys(body.envVars);
      if (keys.length > MAX_ENV_VARS) {
        return c.json({ error: `envVars may have at most ${String(MAX_ENV_VARS)} keys` }, 400);
      }
      for (const k of keys) {
        if (!ENV_KEY_RE.test(k)) {
          return c.json({ error: `envVars key "${k}" must match ${ENV_KEY_RE.source}` }, 400);
        }
        const v = body.envVars[k];
        if (typeof v !== "string" || v.length > MAX_ENV_VALUE_LEN) {
          return c.json({ error: `envVars["${k}"] must be a string ≤${String(MAX_ENV_VALUE_LEN)} chars` }, 400);
        }
      }
    }

    // Find user's ready infrastructure — by name if specified, otherwise first ready
    let infraRows = db
      .select()
      .from(schema.infrastructureConfigs)
      .where(
        and(
          eq(schema.infrastructureConfigs.userId, user.id),
          eq(schema.infrastructureConfigs.status, "ready"),
        ),
      )
      .all();

    if (body.infraName) {
      infraRows = infraRows.filter((r) => r.name === body.infraName);
      if (infraRows.length === 0) {
        return c.json({ error: `No ready infrastructure named "${body.infraName}"` }, 400);
      }
    }

    const infra = infraRows[0];
    if (!infra) {
      return c.json(
        { error: "No infrastructure configured. Set up a hosting node in Infrastructure settings." },
        400,
      );
    }

    // Idempotent deploy: if a non-destroyed deployment already exists with
    // this name for this user, treat the call as an update — reuse the row,
    // keep the host port, keep the domain (changes require destroy+redeploy).
    const existingRows = db
      .select()
      .from(schema.deployments)
      .where(
        and(
          eq(schema.deployments.userId, user.id),
          eq(schema.deployments.name, body.name),
          not(eq(schema.deployments.status, "destroyed")),
        ),
      )
      .all();

    const existing = existingRows[0];
    if (existing && existing.status === "deploying") {
      return c.json(
        { error: `Deployment "${body.name}" is already deploying — wait for it to finish or destroy it.` },
        409,
      );
    }

    // Reuse host port from the stored URL (http://host:PORT) for domain-less
    // deploys. Domain-based deploys don't use a host port.
    let existingHostPort: number | undefined;
    if (existing?.url) {
      const m = /:(\d+)(?:\/|$)/.exec(existing.url);
      if (m?.[1]) existingHostPort = parseInt(m[1], 10);
    }

    try {
      const result = await deploy(
        {
          userId: user.id,
          infraId: existing?.infraId ?? infra.id,
          name: body.name,
          domain: existing?.domain ?? body.domain,
          internalOnly: existing?.internalOnly ?? body.internalOnly,
          sourcePath: body.sourcePath,
          composeConfig: body.composeConfig,
          composePath: body.composePath,
          gitUrl: body.gitUrl,
          gitBranch: body.gitBranch,
          envVars: body.envVars,
          database: body.database,
          dnsName: body.dnsName,
          existingDeployId: existing?.id,
          existingHostPort,
        },
        c.get("agentSession"),
      );

      return c.json(result, existing ? 200 : 201);
    } catch (err) {
      console.error("[deploy] Error:", err instanceof Error ? err.message : err);
      return c.json({ error: "Deploy failed" }, 500);
    }
  });

  // POST /api/deploy/targets — return viable deploy targets for the caller.
  //
  // Called by the `agentdeploy` MCP BEFORE a deploy call, with facts about
  // the source directory the MCP introspected locally (has Dockerfile?,
  // has compose?, is a static site?, git state). The server filters
  // configured integrations by what each can accept, lazy-seeds a
  // local-docker row when the socket is available, and returns a
  // target list the agent can surface to the user.
  //
  // Shape matches the "choose_target" response the MCP emits to Claude
  // Code — the MCP wraps this payload plus a `hint`.
  app.post("/targets", async (c) => {
    const user = c.get("user");
    const body = await c.req.json<{
      source_analysis?: {
        hasDockerfile?: boolean;
        hasCompose?: boolean;
        isStaticSite?: boolean;
        gitState?: {
          remote?: string;
          branch?: string;
          clean?: boolean;
          aheadOfOrigin?: boolean;
        } | null;
      };
    }>();

    // Lazy-seed always-on virtual integrations so fresh installs see
    // them without clicking through the Integrations page.
    ensureLocalDockerInfra(user.id);
    ensureGitHubPagesInfra(user.id);

    const infras = db
      .select()
      .from(schema.infrastructureConfigs)
      .where(
        and(
          eq(schema.infrastructureConfigs.userId, user.id),
          eq(schema.infrastructureConfigs.status, "ready"),
        ),
      )
      .all();

    const src = body.source_analysis ?? {};
    const viable: Array<{
      id: string;
      label: string;
      description: string;
      requires?: string[];
    }> = [];

    const localInfra = infras.find((i) => i.provider === "local-docker");
    if (localInfra) {
      if (src.hasDockerfile || src.hasCompose) {
        const host = process.env["AGENTHUB_PUBLIC_HOST"] ?? "<agenthub-host>";
        viable.push({
          id: "local",
          label: "Local Docker (zero setup)",
          description: `Build + run on this AgentHub host's Docker daemon. Assigned URL: http://${host}:<auto-port>. Shareable on LAN; no TLS.`,
        });
      } else {
        viable.push({
          id: "local",
          label: "Local Docker (needs Dockerfile)",
          description: "Add a Dockerfile or compose.yaml to the project root to enable this target.",
          requires: ["Dockerfile or compose.yaml"],
        });
      }
    }

    // git-pull targets (Dokploy, DO Apps, GH Pages) all require the
    // caller's source to be a clean pushed repo. Compute once.
    const gitClean =
      src.gitState?.clean === true && src.gitState?.aheadOfOrigin !== true;
    const gitRemote = src.gitState?.remote ?? null;
    const gitBranch = src.gitState?.branch ?? "main";
    const gitBlocker = !gitRemote
      ? "source has no origin remote — push to GitHub first (try the push_to_github tool)"
      : src.gitState?.aheadOfOrigin
        ? "local commits not pushed to origin"
        : !gitClean
          ? "working tree has uncommitted changes"
          : null;
    const pushedOnGithub = Boolean(
      gitClean && gitRemote && /(^|\/)github\.com[:/]/i.test(gitRemote),
    );

    const dokployInfras = infras.filter((i) => i.provider === "dokploy");
    for (const d of dokployInfras) {
      if (gitClean && gitRemote) {
        viable.push({
          id: `dokploy:${d.name}`,
          label: `Dokploy via GitHub (${d.name})`,
          description: `Dokploy pulls ${gitRemote}@${gitBranch} and builds + runs.`,
        });
      } else {
        viable.push({
          id: `dokploy:${d.name}`,
          label: `Dokploy via GitHub (${d.name}) — not ready`,
          description: `Dokploy pulls from GitHub. Current blocker: ${gitBlocker ?? "source state"}.`,
          requires: ["clean pushed git repo"],
        });
      }
    }

    const doAppsInfras = infras.filter((i) => i.provider === "digitalocean-apps");
    for (const d of doAppsInfras) {
      if (pushedOnGithub) {
        viable.push({
          id: `do-apps:${d.name}`,
          label: `DigitalOcean App Platform (${d.name})`,
          description: `DO pulls ${gitRemote}@${gitBranch}, auto-detects the buildpack, and runs. Default URL: *.ondigitalocean.app.`,
        });
      } else {
        viable.push({
          id: `do-apps:${d.name}`,
          label: `DigitalOcean App Platform (${d.name}) — not ready`,
          description: `DO Apps needs a github.com repo. Current blocker: ${gitBlocker ?? "source is not on github.com"}.`,
          requires: ["pushed github.com repo"],
        });
      }
    }

    const ghPagesInfras = infras.filter((i) => i.provider === "github-pages");
    for (const p of ghPagesInfras) {
      const staticOk = src.isStaticSite === true;
      if (pushedOnGithub && staticOk) {
        viable.push({
          id: `gh-pages:${p.name}`,
          label: `GitHub Pages (${p.name})`,
          description: `Serve ${gitRemote}@${gitBranch} as a static site. URL: https://<owner>.github.io/<repo>.`,
        });
      } else {
        const reason = !staticOk
          ? "source is not a static site (no index.html at root, or has a Dockerfile)"
          : gitBlocker ?? "source state";
        viable.push({
          id: `gh-pages:${p.name}`,
          label: `GitHub Pages (${p.name}) — not ready`,
          description: `Pages is static-only. Current blocker: ${reason}.`,
          requires: staticOk ? ["pushed github.com repo"] : ["static site (no Dockerfile, index.html at root)"],
        });
      }
    }

    return c.json({
      source_analysis: src,
      viable_targets: viable,
    });
  });

  // GET /api/deployments — list deployments (admins see all, users see own)
  app.get("/deployments", (c) => {
    const user = c.get("user");
    const isAdmin = user.role === "admin";

    const rows = isAdmin
      ? db.select().from(schema.deployments).all()
      : db
          .select()
          .from(schema.deployments)
          .where(eq(schema.deployments.userId, user.id))
          .all();

    // Join infra names + providers
    const infraMap = new Map<string, { name: string; provider: string }>();
    const infraIds = [...new Set(rows.map((r) => r.infraId))];
    for (const infraId of infraIds) {
      const infra = db
        .select({
          name: schema.infrastructureConfigs.name,
          provider: schema.infrastructureConfigs.provider,
        })
        .from(schema.infrastructureConfigs)
        .where(eq(schema.infrastructureConfigs.id, infraId))
        .all();
      if (infra[0]) infraMap.set(infraId, { name: infra[0].name, provider: infra[0].provider });
    }

    // Join usernames for admin view
    const userMap = new Map<string, string>();
    if (isAdmin) {
      const userIds = [...new Set(rows.map((r) => r.userId))];
      for (const uid of userIds) {
        const u = db
          .select({ username: schema.users.username })
          .from(schema.users)
          .where(eq(schema.users.id, uid))
          .all();
        if (u[0]) userMap.set(uid, u[0].username);
      }
    }

    return c.json(
      rows
        .filter((d) => d.status !== "destroyed")
        .map((d) => {
          const infra = infraMap.get(d.infraId);
          return {
            ...d,
            infraName: infra?.name ?? "unknown",
            provider: infra?.provider ?? null,
            ...(isAdmin ? { username: userMap.get(d.userId) ?? "unknown" } : {}),
          };
        }),
    );
  });

  // GET /api/deployments/all — include destroyed (for history)
  app.get("/deployments/all", (c) => {
    const user = c.get("user");
    const rows = db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.userId, user.id))
      .all();

    return c.json(rows);
  });

  // GET /api/deployments/:id — single deployment
  app.get("/deployments/:id", (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const isAdmin = user.role === "admin";

    const rows = isAdmin
      ? db.select().from(schema.deployments).where(eq(schema.deployments.id, id)).all()
      : db
          .select()
          .from(schema.deployments)
          .where(and(eq(schema.deployments.id, id), eq(schema.deployments.userId, user.id)))
          .all();

    const row = rows[0];
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(row);
  });

  // GET /api/deployments/:id/logs — container logs
  app.get("/deployments/:id/logs", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const lines = parseInt(c.req.query("lines") ?? "100", 10);

    try {
      const logs = await getDeploymentLogs(id, user.id, lines, user.role === "admin");
      return c.json({ logs });
    } catch (err) {
      console.error("[deploy] Logs error:", err instanceof Error ? err.message : err);
      return c.json({ error: "Failed to fetch logs" }, 500);
    }
  });

  // POST /api/deployments/:id/restart
  app.post("/deployments/:id/restart", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");

    try {
      await restartDeployment(id, user.id, user.role === "admin");
      return c.json({ ok: true });
    } catch (err) {
      console.error("[deploy] Restart error:", err instanceof Error ? err.message : err);
      return c.json({ error: "Restart failed" }, 500);
    }
  });

  // DELETE /api/deployments/:id — destroy deployment
  app.delete("/deployments/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");

    try {
      await destroyDeployment(id, user.id, user.role === "admin");
      return c.json({ destroyed: true });
    } catch (err) {
      console.error("[deploy] Destroy error:", err instanceof Error ? err.message : err);
      return c.json({ error: "Destroy failed" }, 500);
    }
  });

  return app;
}
