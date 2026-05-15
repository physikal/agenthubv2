import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { writeAudit, listAudit } from "./audit.js";
import * as schema from "../../db/schema.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, password_hash TEXT, display_name TEXT, role TEXT, created_at INTEGER);
    INSERT INTO users (id, username, password_hash, display_name, role, created_at) VALUES ('u1', 'alice', 'x', 'Alice', 'user', 0);
    CREATE TABLE agent_auth_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      session_id TEXT,
      ok INTEGER NOT NULL DEFAULT 1,
      error TEXT
    );
  `);
  return drizzle(sqlite, { schema });
}

describe("agent-auth audit", () => {
  it("writes a row and reads it back ordered newest first", async () => {
    const db = makeDb();
    await writeAudit(db, { userId: "u1", action: "connect", toolId: "claude-code", sessionId: "s1", ok: true });
    await new Promise((r) => setTimeout(r, 5));
    await writeAudit(db, { userId: "u1", action: "capture", toolId: "claude-code", sessionId: "s1", ok: true });

    const rows = await listAudit(db, { userId: "u1", limit: 10 });
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.action).toBe("capture");
    expect(second!.action).toBe("connect");
    expect(first!.createdAt).toBeInstanceOf(Date);
  });

  it("records ok=false and error message on failures", async () => {
    const db = makeDb();
    await writeAudit(db, { userId: "u1", action: "connect", toolId: "codex", ok: false, error: "timeout" });
    const rows = await listAudit(db, { userId: "u1", limit: 10 });
    const [first] = rows;
    expect(first).toBeDefined();
    expect(first!.ok).toBe(false);
    expect(first!.error).toBe("timeout");
  });
});
