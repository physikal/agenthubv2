import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { Hono } from "hono";
import { compareSync, hashSync } from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { SessionManager } from "../services/session-manager.js";
import type { AuthUser } from "../middleware/auth.js";

// Repo is mounted at /repo by compose. See docker-compose.yml volumes +
// installer's renderEnv (which writes AGENTHUB_REPO_DIR).
const REPO_DIR = "/repo";

function runGit(args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPO_DIR,
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

export function adminRoutes(sessionManager: SessionManager) {
  const app = new Hono<{ Variables: { user: AuthUser } }>();

  // --- Users ---

  app.get("/users", (c) => {
    const rows = db
      .select({
        id: schema.users.id,
        username: schema.users.username,
        displayName: schema.users.displayName,
        role: schema.users.role,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .all();
    return c.json(rows);
  });

  app.post("/users", async (c) => {
    const body = await c.req.json<{
      username: string;
      password: string;
      displayName?: string;
      role?: string;
    }>();

    if (!body.username?.trim() || !body.password?.trim()) {
      return c.json({ error: "Username and password required" }, 400);
    }
    if (body.username.length > 50) {
      return c.json({ error: "Username too long (max 50 chars)" }, 400);
    }
    if (body.password.length > 128) {
      return c.json({ error: "Password too long (max 128 chars)" }, 400);
    }

    const existing = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, body.username.trim()))
      .all();

    if (existing.length > 0) {
      return c.json({ error: "Username already taken" }, 409);
    }

    const id = randomUUID();
    const hash = hashSync(body.password, 12);
    const role = body.role === "admin" ? "admin" : "user";

    db.insert(schema.users)
      .values({
        id,
        username: body.username.trim(),
        passwordHash: hash,
        displayName: body.displayName?.trim() ?? body.username.trim(),
        role,
      })
      .run();

    return c.json(
      { id, username: body.username.trim(), role },
      201,
    );
  });

  app.patch("/users/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{
      password?: string;
      displayName?: string;
      role?: string;
    }>();

    const existing = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .all();
    if (existing.length === 0) {
      return c.json({ error: "User not found" }, 404);
    }

    const updates: Record<string, string> = {};
    if (body.password?.trim()) {
      if (body.password.length > 128) {
        return c.json({ error: "Password too long" }, 400);
      }
      updates["passwordHash"] = hashSync(body.password, 12);
    }
    if (body.displayName?.trim()) {
      updates["displayName"] = body.displayName.trim();
    }
    if (body.role === "admin" || body.role === "user") {
      updates["role"] = body.role;
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "No valid fields to update" }, 400);
    }

    db.update(schema.users)
      .set(updates)
      .where(eq(schema.users.id, id))
      .run();

    return c.json({ ok: true });
  });

  app.delete("/users/:id", (c) => {
    const id = c.req.param("id");

    // Prevent deleting yourself
    const currentUser = c.get("user");
    if (currentUser?.id === id) {
      return c.json({ error: "Cannot delete your own account" }, 400);
    }

    db.delete(schema.users).where(eq(schema.users.id, id)).run();
    return c.json({ ok: true });
  });

  // --- Sessions (all users) ---

  app.get("/sessions", (c) => {
    const allSessions = sessionManager.listSessions();
    return c.json(allSessions);
  });

  app.post("/sessions/:id/end", async (c) => {
    const id = c.req.param("id");
    await sessionManager.endSession(id);
    return c.json({ ok: true });
  });

  // --- Version + Update ---
  //
  // Drives the Settings page "Version" panel. Same logic the `agenthub`
  // CLI runs from the host shell — just plumbed through HTTP so the web
  // UI can pull updates without the user dropping to a terminal.

  app.get("/version", (c) => {
    try {
      // fetch is fire-and-forget; it populates origin/main but doesn't
      // block the response if the network is slow.
      try { runGit(["fetch", "--quiet", "origin", "main"]); }
      catch { /* non-fatal — stale origin is fine for a status view */ }

      const currentSha = runGit(["rev-parse", "HEAD"]);
      const currentShort = runGit(["rev-parse", "--short", "HEAD"]);
      const currentDate = runGit(["log", "-1", "--format=%cI", "HEAD"]);
      const currentSubject = runGit(["log", "-1", "--format=%s", "HEAD"]);

      let latestSha = currentSha;
      let latestShort = currentShort;
      let behind = 0;
      let ahead = 0;
      let pending: { sha: string; subject: string }[] = [];
      try {
        latestSha = runGit(["rev-parse", "origin/main"]);
        latestShort = runGit(["rev-parse", "--short", "origin/main"]);
        behind = parseInt(runGit(["rev-list", "--count", `${currentSha}..${latestSha}`]), 10) || 0;
        ahead = parseInt(runGit(["rev-list", "--count", `${latestSha}..${currentSha}`]), 10) || 0;
        if (behind > 0) {
          const log = runGit([
            "log",
            "--format=%H\t%s",
            `${currentSha}..${latestSha}`,
          ]);
          pending = log
            .split("\n")
            .filter(Boolean)
            .slice(0, 10)
            .map((line) => {
              const [sha, ...rest] = line.split("\t");
              return { sha: (sha ?? "").slice(0, 7), subject: rest.join("\t") };
            });
        }
      } catch { /* no origin set up — treat as up-to-date */ }

      return c.json({
        current: { sha: currentShort, fullSha: currentSha, date: currentDate, subject: currentSubject },
        latest: { sha: latestShort, fullSha: latestSha },
        behind,
        ahead,
        pending,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "git failed";
      return c.json({ error: `version check failed: ${msg}` }, 500);
    }
  });

  app.post("/update", (c) => {
    // Spawn a detached one-shot updater container. It runs the same
    // `agenthub update` CLI that lives on the host at /usr/local/bin/agenthub
    // — one code path, zero drift — mounting the repo + docker socket.
    //
    // The updater will eventually `docker compose up -d --force-recreate
    // agenthub-server`, which kills THIS process. We return 202 immediately
    // so the client can poll /api/admin/version and auto-reload once the
    // SHA shifts.
    const repoDir = process.env["AGENTHUB_REPO_DIR"];
    if (!repoDir) {
      return c.json(
        { error: "AGENTHUB_REPO_DIR not set — server compose needs updating" },
        500,
      );
    }

    const jobId = randomUUID();
    const containerName = `agenthub-updater-${jobId.slice(0, 8)}`;

    // Pass through AGENTHUB_OWNER so the updater's EXIT trap restores the
    // repo's pre-run uid:gid after root-side git writes. Without this the
    // updater container leaves root-owned objects under .git/ that break
    // the operator's next non-sudo `git` call. Empty = updater falls back
    // to package.json stat (upgrades from older installs).
    const owner = process.env["AGENTHUB_OWNER"] ?? "";

    try {
      spawn(
        "docker",
        [
          "run",
          "--rm",
          "--detach",
          "--name", containerName,
          "-v", `${repoDir}:/repo:rw`,
          "-v", "/var/run/docker.sock:/var/run/docker.sock",
          "-e", "AGENTHUB_DIR=/repo",
          "-e", `AGENTHUB_OWNER=${owner}`,
          "agenthubv2-updater:local",
          "update",
        ],
        { stdio: "ignore", detached: true },
      ).unref();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "docker spawn failed";
      return c.json({ error: msg }, 500);
    }

    return c.json(
      {
        accepted: true,
        jobId,
        containerName,
        hint: "Poll /api/admin/version every ~2s; the server will be unreachable briefly during recreate, then return with a new SHA.",
      },
      202,
    );
  });

  // --- Infisical console credentials ---
  //
  // Returns the bundled Infisical admin email + password so operators can
  // log into the console at :8443. Gated by re-entering the caller's
  // current AgentHub admin password (same bcrypt-compare dance as
  // /api/auth/change-password) so a stolen session cookie alone can't
  // leak the Infisical admin login.
  //
  // Values come from env vars wired by compose — installer writes them to
  // .env during first-run bootstrap. If not set (e.g., pre-existing
  // Infisical instance we didn't bootstrap), we return 404 with a hint.
  app.post("/infisical-credentials", async (c) => {
    const user = c.get("user");
    const body = await c.req
      .json<{ currentPassword?: string }>()
      .catch((): { currentPassword?: string } => ({}));

    if (!body.currentPassword) {
      return c.json({ error: "Current password required" }, 400);
    }

    const rows = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, user.id))
      .all();
    const dbUser = rows[0];
    if (!dbUser || !compareSync(body.currentPassword, dbUser.passwordHash)) {
      return c.json({ error: "Current password is incorrect" }, 401);
    }

    const email = process.env["INFISICAL_ADMIN_EMAIL"] ?? "";
    const password = process.env["INFISICAL_ADMIN_PASSWORD"] ?? "";
    if (!email || !password) {
      return c.json(
        {
          error:
            "Infisical admin credentials are not stored on this install. " +
            "This happens when AgentHub was pointed at an existing Infisical " +
            "instance instead of the bundled one. Log in with the credentials " +
            "you set when that instance was provisioned.",
        },
        404,
      );
    }

    return c.json({ email, password });
  });

  return app;
}
