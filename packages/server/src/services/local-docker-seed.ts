import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { InfrastructureConfig } from "../db/schema.js";

/**
 * Lazy-seeded infra rows for targets that don't need user-entered
 * config:
 *
 *   - `local-docker` — always seeded when the server's socket mount is
 *     enabled. Zero config.
 *   - `github-pages`  — seeded when the user already has a `github`
 *     integration. GH Pages has no distinct config of its own; it reuses
 *     the user's GitHub PAT.
 *
 * Called at deploy-intent time (targets probe, deploy call) rather than
 * on server boot so new users pick these up without a restart.
 */

type Provider = InfrastructureConfig["provider"];

function findByProvider(userId: string, provider: Provider): InfrastructureConfig | null {
  return (
    db
      .select()
      .from(schema.infrastructureConfigs)
      .where(
        and(
          eq(schema.infrastructureConfigs.userId, userId),
          eq(schema.infrastructureConfigs.provider, provider),
        ),
      )
      .get() ?? null
  );
}

export function ensureLocalDockerInfra(userId: string): InfrastructureConfig | null {
  if (process.env["AGENTHUB_ALLOW_SOCKET_MOUNT"] !== "true") return null;
  const existing = findByProvider(userId, "local-docker");
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

export function ensureGitHubPagesInfra(userId: string): InfrastructureConfig | null {
  // Only seed when the user has a working github integration — otherwise
  // a gh-pages target would surface as "viable" with no way to authenticate.
  const github = findByProvider(userId, "github");
  if (!github || github.status !== "ready") return null;

  const existing = findByProvider(userId, "github-pages");
  if (existing) return existing;

  const now = new Date();
  const row: InfrastructureConfig = {
    id: randomUUID(),
    userId,
    name: "GitHub Pages",
    provider: "github-pages",
    config: "{}",
    hostingNodeIp: "github-pages",
    hostingNodeId: "github-pages",
    hostingNodeNode: null,
    status: "ready",
    statusDetail: null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(schema.infrastructureConfigs).values(row).run();
  return row;
}
