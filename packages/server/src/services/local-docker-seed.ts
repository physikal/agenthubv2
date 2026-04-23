import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { InfrastructureConfig } from "../db/schema.js";

/**
 * Return the user's local-docker infra row, creating it on first access.
 * Returns null when AGENTHUB_ALLOW_SOCKET_MOUNT is not enabled — callers
 * must filter that case out of the UI/MCP's list of viable targets.
 *
 * This is the zero-setup path: a user who just installed AgentHub and
 * typed `deploy this` never has to click "Create integration" — we lazy-
 * create the row on first deploy-intent signal (deploy call or targets
 * probe).
 */
export function ensureLocalDockerInfra(userId: string): InfrastructureConfig | null {
  if (process.env["AGENTHUB_ALLOW_SOCKET_MOUNT"] !== "true") return null;

  const existing = db
    .select()
    .from(schema.infrastructureConfigs)
    .where(
      and(
        eq(schema.infrastructureConfigs.userId, userId),
        eq(schema.infrastructureConfigs.provider, "local-docker"),
      ),
    )
    .get();
  if (existing) return existing;

  const now = new Date();
  const row: InfrastructureConfig = {
    id: randomUUID(),
    userId,
    name: "Local Docker",
    provider: "local-docker",
    config: "{}",
    hostingNodeIp: "127.0.0.1",
    hostingNodeId: "local-docker",
    hostingNodeNode: null,
    status: "ready",
    statusDetail: null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(schema.infrastructureConfigs).values(row).run();
  return row;
}
