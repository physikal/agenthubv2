import { desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { agentAuthAudit } from "../../db/schema.js";

export type AuditAction = "connect" | "disconnect" | "refresh" | "hydrate" | "capture";

export interface AuditEntry {
  userId: string;
  action: AuditAction;
  toolId: string;
  sessionId?: string;
  ok: boolean;
  error?: string;
}

export interface AuditRow extends AuditEntry {
  id: number;
  createdAt: Date;
}

export async function writeAudit(
  db: BetterSQLite3Database<Record<string, unknown>>,
  entry: AuditEntry,
): Promise<void> {
  await db.insert(agentAuthAudit).values({
    userId: entry.userId,
    action: entry.action,
    toolId: entry.toolId,
    sessionId: entry.sessionId,
    ok: entry.ok,
    error: entry.error,
  });
}

export async function listAudit(
  db: BetterSQLite3Database<Record<string, unknown>>,
  opts: { userId: string; limit: number },
): Promise<AuditRow[]> {
  const rows = await db
    .select()
    .from(agentAuthAudit)
    .where(eq(agentAuthAudit.userId, opts.userId))
    .orderBy(desc(agentAuthAudit.createdAt), desc(agentAuthAudit.id))
    .limit(opts.limit);
  return rows.map((r) => {
    const row: AuditRow = {
      id: r.id,
      createdAt: r.createdAt,
      userId: r.userId,
      action: r.action as AuditAction,
      toolId: r.toolId,
      ok: r.ok,
    };
    if (r.sessionId !== null) row.sessionId = r.sessionId;
    if (r.error !== null) row.error = r.error;
    return row;
  });
}
