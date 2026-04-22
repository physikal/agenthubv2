import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { compareSync, hashSync } from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";

/**
 * Get the real client IP for rate limiting. Trusting `X-Forwarded-For` from
 * the client would let an attacker send a fresh header value each attempt to
 * rotate through the rate limit bucket. In production we only trust
 * `X-Real-IP` (set by the reverse proxy in front of AgentHub, e.g. Traefik);
 * otherwise we fall back to the socket remote address.
 */
function getClientIp(c: Context): string {
  if (process.env["NODE_ENV"] === "production") {
    // A correctly-configured reverse proxy strips any client-sent X-Real-IP
    // and sets it to the real peer. If the header is missing we intentionally
    // bucket to "unknown" rather than trust a client-forged X-Forwarded-For.
    const realIp = c.req.header("x-real-ip")?.trim();
    if (realIp) return realIp;
  }
  // Dev / non-prod: fall back to whatever X-Forwarded-For the dev proxy sends,
  // else "unknown". Local-only, no bypass risk.
  const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return xff ?? "unknown";
}

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_USERNAME_LEN = 50;
const MAX_PASSWORD_LEN = 128;

// Pre-computed hash for timing-safe comparison when user doesn't exist
const DUMMY_HASH = hashSync("dummy-password-for-timing", 12);

// Rate limiting: max 10 login attempts per IP per minute
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= LOGIN_MAX_ATTEMPTS;
}

// Cleanup stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 300_000);

export function authRoutes() {
  const app = new Hono<{ Variables: { user: AuthUser } }>();

  app.post("/login", async (c) => {
    const ip = getClientIp(c);
    if (!checkLoginRateLimit(ip)) {
      return c.json({ error: "Too many login attempts. Try again in a minute." }, 429);
    }

    const body = await c.req.json<{ username: string; password: string }>();

    if (!body.username?.trim() || !body.password) {
      return c.json({ error: "Username and password required" }, 400);
    }
    if (body.username.length > MAX_USERNAME_LEN || body.password.length > MAX_PASSWORD_LEN) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const rows = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, body.username.trim()))
      .all();

    const user = rows[0];

    // Timing-safe: always run bcrypt comparison even if user doesn't exist
    const hashToCompare = user?.passwordHash ?? DUMMY_HASH;
    const passwordValid = compareSync(body.password, hashToCompare);

    if (!user || !passwordValid) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    db.insert(schema.sessionTokens)
      .values({ token, userId: user.id, expiresAt })
      .run();

    setCookie(c, "session_token", token, {
      httpOnly: true,
      secure: process.env["NODE_ENV"] === "production",
      sameSite: "Lax",
      path: "/",
      maxAge: TOKEN_TTL_MS / 1000,
    });

    return c.json({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    });
  });

  app.post("/logout", (c) => {
    const token = getCookie(c, "session_token");

    if (token) {
      db.delete(schema.sessionTokens)
        .where(eq(schema.sessionTokens.token, token))
        .run();
    }

    deleteCookie(c, "session_token", { path: "/" });
    return c.json({ ok: true });
  });

  // Middleware-protected routes. Registered with authMiddleware directly
  // on this sub-app so we don't rely on the outer index.ts duplicate-get
  // shim (which Hono's trie didn't actually invoke because the sub-app
  // route matched first).
  app.use("/me", authMiddleware);
  app.use("/change-password", authMiddleware);

  app.post("/change-password", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const body = await c.req.json<{ currentPassword: string; newPassword: string }>();

    if (!body.currentPassword || !body.newPassword) {
      return c.json({ error: "Current and new password required" }, 400);
    }
    if (body.newPassword.length < 8) {
      return c.json({ error: "Password must be at least 8 characters" }, 400);
    }
    if (body.newPassword.length > MAX_PASSWORD_LEN) {
      return c.json({ error: "Password too long" }, 400);
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

    const newHash = hashSync(body.newPassword, 12);
    db.update(schema.users)
      .set({ passwordHash: newHash })
      .where(eq(schema.users.id, user.id))
      .run();

    return c.json({ ok: true });
  });

  app.get("/me", (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const rows = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, user.id))
      .all();

    const full = rows[0];
    if (!full) return c.json({ error: "User not found" }, 404);

    return c.json({
      id: full.id,
      username: full.username,
      displayName: full.displayName,
      role: full.role,
    });
  });

  return app;
}
