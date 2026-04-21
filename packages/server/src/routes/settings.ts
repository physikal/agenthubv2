import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { AuthUser } from "../middleware/auth.js";
import { adminMiddleware } from "../middleware/auth.js";

const MASKED_KEYS = new Set(["anthropic_api_key", "claude_credentials", "minimax_api_key"]);

function maskValue(key: string, value: string): string {
  if (MASKED_KEYS.has(key) && value.length > 4) {
    return "\u2022".repeat(8) + value.slice(-4);
  }
  return value;
}

export function settingsRoutes() {
  const app = new Hono<{ Variables: { user: AuthUser } }>();

  // All settings routes are admin-only
  app.use("*", adminMiddleware);

  app.get("/", (c) => {
    const rows = db.select().from(schema.settings).all();
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = maskValue(row.key, row.value);
    }
    return c.json(result);
  });

  app.put("/", async (c) => {
    const body = await c.req.json<Record<string, string>>();

    for (const [key, value] of Object.entries(body)) {
      if (typeof value !== "string") continue;

      db.insert(schema.settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
        .run();
    }

    return c.json({ ok: true });
  });

  app.get("/:key", (c) => {
    const rows = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, c.req.param("key")))
      .all();

    const row = rows[0];
    if (!row) return c.json({ error: "Setting not found" }, 404);
    return c.json({ key: row.key, value: maskValue(row.key, row.value) });
  });

  return app;
}
