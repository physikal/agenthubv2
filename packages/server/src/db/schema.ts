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
    enum: [
      "docker",
      "digitalocean",
      "digitalocean-apps",
      "dokploy",
      "local-docker",
      "github-pages",
      "cloudflare",
      "b2",
      "github",
    ],
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

/**
 * Single-row config for the GitHub App this AgentHub install represents.
 * The admin registers the App (via manifest flow or manually) once; every
 * user's installations then reference it. Secrets (privateKey,
 * webhookSecret, clientSecret) live in Infisical at /system/github-app/*
 * — only non-secret metadata stays here. The id column is hardcoded to
 * "default" so the UNIQUE + PRIMARY KEY guard against accidental multi-row
 * drift.
 */
export const githubAppConfig = sqliteTable("github_app_config", {
  id: text("id").primaryKey().default("default"),
  appId: integer("app_id").notNull(),
  slug: text("slug").notNull(),
  clientId: text("client_id").notNull(),
  name: text("name").notNull(),
  htmlUrl: text("html_url").notNull(),
  registeredByUserId: text("registered_by_user_id")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * One row per GitHub App installation on a user's account or organization.
 * installationId is GitHub's numeric identifier (unique across the whole
 * App); userId is the AgentHub user who initiated the install. We persist
 * metadata for UI display (account login/type, repo selection); tokens
 * are always minted fresh via @octokit/auth-app and never stored.
 */
export const githubInstallations = sqliteTable("github_installations", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  installationId: integer("installation_id").notNull().unique(),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type", { enum: ["User", "Organization"] }).notNull(),
  targetType: text("target_type", { enum: ["User", "Organization"] }).notNull(),
  repositorySelection: text("repository_selection", { enum: ["all", "selected"] })
    .notNull(),
  /** JSON snapshot of the permissions GitHub granted at install time. */
  permissions: text("permissions").notNull().default("{}"),
  /** Set via the installation.suspend webhook (or lazy 401 detection). */
  suspendedAt: integer("suspended_at", { mode: "timestamp" }),
  /** Set via installation.deleted webhook or explicit server-side uninstall. */
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Short-lived CSRF tokens for the /apps/:slug/installations/new redirect.
 * 32 random bytes as hex; TTL 15 minutes. Each row is single-use — `usedAt`
 * is stamped on exchange to prevent replay. Cleaned up lazily; stale rows
 * are safe to leave.
 */
export const githubInstallState = sqliteTable("github_install_state", {
  state: text("state").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  usedAt: integer("used_at", { mode: "timestamp" }),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type SessionStatus = NonNullable<Session["status"]>;
export type InfrastructureConfig = typeof infrastructureConfigs.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type BackupRun = typeof backupRuns.$inferSelect;
export type NewBackupRun = typeof backupRuns.$inferInsert;
export type GithubAppConfig = typeof githubAppConfig.$inferSelect;
export type GithubInstallation = typeof githubInstallations.$inferSelect;
export type NewGithubInstallation = typeof githubInstallations.$inferInsert;
export type GithubInstallState = typeof githubInstallState.$inferSelect;
export type UserPackage = typeof userPackages.$inferSelect;
export type UserPackageStatus = NonNullable<UserPackage["status"]>;
