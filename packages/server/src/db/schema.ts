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
  lxcVmid: integer("lxc_vmid"),
  lxcNode: text("lxc_node"),
  lxcIp: text("lxc_ip"),
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
  provider: text("provider", { enum: ["proxmox", "cloudflare"] }).notNull(),
  config: text("config").notNull(), // JSON: provider-specific credentials
  hostingNodeIp: text("hosting_node_ip"),
  hostingNodeId: text("hosting_node_id"), // VMID (proxmox) or droplet ID (DO)
  hostingNodeNode: text("hosting_node_node"), // PVE node name
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
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Warm pool of pre-provisioned LXC containers. Mirrors ContainerPool in-memory
 * state so that a pod restart mid-provision doesn't leak containers against
 * the hard cap. Rows are deleted when a session claims the container — from
 * that point the session table is authoritative (session.lxcVmid/Node/Ip).
 */
/**
 * One row per backup save/restore attempt. Used to render run history on the
 * Backups page and to anchor point-in-time restore — a completed successful
 * `save` row's `endedAt` is a valid `--b2-versions-at` timestamp (assuming the
 * B2 bucket preserves old versions).
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
  // For restore: ISO timestamp passed to --b2-versions-at (null = latest).
  snapshotAt: integer("snapshot_at", { mode: "timestamp" }),
  error: text("error"),
});

export const poolContainers = sqliteTable("pool_containers", {
  vmid: integer("vmid").primaryKey(),
  node: text("node").notNull(),
  ip: text("ip"),
  agentToken: text("agent_token").notNull(),
  state: text("state", {
    enum: ["provisioning", "pending", "ready"],
  }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type SessionStatus = NonNullable<Session["status"]>;
export type InfrastructureConfig = typeof infrastructureConfigs.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type PoolContainerRow = typeof poolContainers.$inferSelect;
export type PoolContainerState = PoolContainerRow["state"];
export type BackupRun = typeof backupRuns.$inferSelect;
export type NewBackupRun = typeof backupRuns.$inferInsert;
