import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import type { WorkspaceTrigger } from "./types.js";

type Kind = "save" | "restore";
type Status = "success" | "failed";
type HistoryTrigger = "manual" | "cli" | "auto-update";

export function toHistoryTrigger(t: WorkspaceTrigger): HistoryTrigger {
  return t === "auto-restore-install" ? "cli" : t;
}

export function startWorkspaceRun(userId: string, kind: Kind, trigger: HistoryTrigger): string {
  const id = randomUUID();
  db.insert(schema.backupRuns)
    .values({ id, userId, kind, status: "running", startedAt: new Date(), trigger })
    .run();
  return id;
}

export function finishWorkspaceRun(
  id: string,
  status: Status,
  fields: { bytes?: number; localPath?: string; b2Path?: string | null; error?: string } = {},
): void {
  db.update(schema.backupRuns)
    .set({
      status,
      endedAt: new Date(),
      ...(fields.bytes !== undefined ? { bytes: fields.bytes } : {}),
      ...(fields.localPath !== undefined ? { localPath: fields.localPath } : {}),
      ...(fields.b2Path !== undefined ? { b2Path: fields.b2Path } : {}),
      ...(fields.error !== undefined ? { error: fields.error } : {}),
    })
    .where(eq(schema.backupRuns.id, id))
    .run();
}

export function listWorkspaceRuns(userId: string | null, limit = 50) {
  const base = db.select().from(schema.backupRuns);
  const q = userId ? base.where(eq(schema.backupRuns.userId, userId)) : base;
  return q.orderBy(desc(schema.backupRuns.startedAt)).limit(limit).all();
}
