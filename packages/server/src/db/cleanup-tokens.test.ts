import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema, initDb, cleanupExpiredSessionTokens } from "./index.js";

// initDb seeds an admin user we can hang tokens off (FK constraint).
beforeAll(() => {
  initDb();
});

function adminUserId(): string {
  const u = db.select().from(schema.users).where(eq(schema.users.username, "admin")).all()[0];
  if (!u) throw new Error("admin user not seeded");
  return u.id;
}

describe("cleanupExpiredSessionTokens", () => {
  beforeEach(() => {
    db.delete(schema.sessionTokens).run();
  });

  it("keeps tokens that expire in the future, deletes only past ones", () => {
    const userId = adminUserId();
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // +30d
    const past = new Date(Date.now() - 60 * 60 * 1000); // -1h

    db.insert(schema.sessionTokens).values([
      { token: "future-token", userId, expiresAt: future },
      { token: "past-token", userId, expiresAt: past },
    ]).run();

    const removed = cleanupExpiredSessionTokens();
    expect(removed).toBe(1);

    const remaining = db.select().from(schema.sessionTokens).all().map((t) => t.token);
    expect(remaining).toEqual(["future-token"]);
  });

  it("does NOT delete a freshly-created 30-day token (the seconds/ms regression)", () => {
    // This is the exact bug that logged everyone out hourly: comparing the
    // seconds-stored expires_at against Date.now() in ms always evaluated
    // true. A fresh 30-day token must survive a cleanup run.
    const userId = adminUserId();
    db.insert(schema.sessionTokens).values({
      token: "fresh-30d",
      userId,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }).run();

    const removed = cleanupExpiredSessionTokens();
    expect(removed).toBe(0);
    expect(db.select().from(schema.sessionTokens).all()).toHaveLength(1);
  });
});
