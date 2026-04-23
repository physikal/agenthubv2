import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  role: text("role", { enum: ["user", "admin"] })
    .notNull()
    .default("user"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const sessionTokens = sqliteTable("session_tokens", {
  token: text("token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
});

export const userCredentials = sqliteTable("user_credentials", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  claudeCredentials: text("claude_credentials"),
  backupConfig: text("backup_config"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status", {
    enum: [
      "creating",
      "starting",
      "waiting_login",
      "active",
      "waiting_input",
      "idle",
      "completed",
      "failed",
    ],
  })
    .notNull()
    .default("creating"),
  statusDetail: text("status_detail").default(""),
  userId: text("user_id").references(() => users.id),
  workspaceId: text("workspace_id"),
  workspaceHost: text("workspace_host"),
  workspaceIp: text("workspace_ip"),
  providerId: text("provider_id"),
  agentToken: text("agent_token"),
  repo: text("repo"),
  prompt: text("prompt"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  endedAt: integer("ended_at", { mode: "timestamp" }),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const infrastructureConfigs = sqliteTable("infrastructure_configs", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull().default(""),
  provider: text("provider", {
    enum: ["docker", "digitalocean", "dokploy", "cloudflare", "b2", "github"],
  }).notNull(),
  config: text("config").notNull(),
  hostingNodeIp: text("hosting_node_ip"),
  hostingNodeId: text("hosting_node_id"),
  hostingNodeNode: text("hosting_node_node"),
  status: text("status", {
    enum: ["pending", "provisioning", "ready", "error"],
  })
    .notNull()
    .default("pending"),
  statusDetail: text("status_detail"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const deployments = sqliteTable("deployments", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  infraId: text("infra_id")
    .notNull()
    .references(() => infrastructureConfigs.id),
  name: text("name").notNull(),
  domain: text("domain"),
  internalOnly: integer("internal_only", { mode: "boolean" })
    .notNull()
    .default(false),
  status: text("status", {
    enum: ["deploying", "running", "stopped", "failed", "destroyed"],
  })
    .notNull()
    .default("deploying"),
  statusDetail: text("status_detail"),
  url: text("url"),
  containerId: text("container_id"),
  sourcePath: text("source_path"),
  composeConfig: text("compose_config"),
  // Git-based deploys (Dokploy, and potentially other providers later):
  // clone + build from a Git URL instead of uploading source or receiving
  // a pre-built compose. Populated only when buildStrategy = "git-pull".
  gitUrl: text("git_url"),
  gitBranch: text("git_branch"),
  buildStrategy: text("build_strategy", {
    enum: ["source-upload", "compose-inline", "git-pull"],
  }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * One row per backup save/restore attempt. Used to render run history on the
 * Backups page and to anchor point-in-time restore.
 */
export const backupRuns = sqliteTable("backup_runs", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["save", "restore"] }).notNull(),
  status: text("status", { enum: ["running", "success", "failed"] })
    .notNull()
    .default("running"),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
  endedAt: integer("ended_at", { mode: "timestamp" }),
  bytes: integer("bytes"),
  fileCount: integer("file_count"),
  snapshotAt: integer("snapshot_at", { mode: "timestamp" }),
  error: text("error"),
});

/**
 * Per-user record of add-on agent CLIs installed into the workspace's
 * persistent /home/coder/.local tree. Built-ins (Claude Code, OpenCode,
 * MiniMax) live in the image layer and are not tracked here.
 */
export const userPackages = sqliteTable("user_packages", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  packageId: text("package_id").notNull(),
  status: text("status", {
    enum: ["installing", "ready", "error", "removing"],
  }).notNull(),
  version: text("version"),
  installedAt: integer("installed_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  error: text("error"),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type SessionStatus = NonNullable<Session["status"]>;
export type InfrastructureConfig = typeof infrastructureConfigs.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type BackupRun = typeof backupRuns.$inferSelect;
export type NewBackupRun = typeof backupRuns.$inferInsert;
export type UserPackage = typeof userPackages.$inferSelect;
export type UserPackageStatus = NonNullable<UserPackage["status"]>;
