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
  purpose: text("purpose", { enum: ["user", "agent-auth"] }).notNull().default("user"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  endedAt: integer("ended_at", { mode: "timestamp" }),
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
      "ai-anthropic",
      "ai-minimax",
      "ai-openai",
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
  localPath: text("local_path"),
  b2Path: text("b2_path"),
  trigger: text("trigger", { enum: ["manual", "cli", "auto-update"] }),
});

/**
 * Per-user record of agent CLIs installed into the workspace's persistent
 * /home/coder/.local tree. Includes both essentials (auto-installed by
 * the daemon on session-active) and user-installed entries from the
 * Packages page. Latest-version metadata for the catalog lives in
 * `package_version_cache`.
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

/**
 * Singleton config row for install-state backup. Only id=1 ever exists;
 * enforced in code via insertOrUpdate by id=1.
 */
export const installBackupConfig = sqliteTable("install_backup_config", {
  id: integer("id").primaryKey(), // singleton: only id=1 ever exists
  b2KeyId: text("b2_key_id"),
  b2Bucket: text("b2_bucket"),
  b2PathPrefix: text("b2_path_prefix").default("installs/"),
  retentionKeepLast: integer("retention_keep_last").default(10),
  // Backend type: "b2" (default) or "s3" (any S3-compatible: R2, MinIO,
  // Wasabi, Storj, AWS). NULL is treated as "b2" for installs configured
  // before pluggable backends landed.
  backend: text("backend"),
  // S3-only: endpoint URL for non-AWS providers
  // (e.g. https://account.r2.cloudflarestorage.com).
  endpoint: text("endpoint"),
  // S3-only: region (default "auto" — works for R2 + most non-AWS).
  region: text("region"),
  updatedAt: text("updated_at").notNull(),
});

/**
 * One row per install-state backup run (create or restore). Provides audit
 * history for the Install Backup admin page.
 */
export const installBackupRuns = sqliteTable("install_backup_runs", {
  id: text("id").primaryKey(), // UUID
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  status: text("status", { enum: ["running", "ok", "failed"] }).notNull(),
  bytes: integer("bytes"),
  localPath: text("local_path"),
  b2Path: text("b2_path"),
  trigger: text("trigger", { enum: ["manual", "auto-update", "cli"] }).notNull(),
  error: text("error"),
  note: text("note"),
});

/**
 * One row per agent-CLI auth event. Records connect/disconnect/refresh/hydrate
 * and per-tool capture events for auditing and debugging. Written by T1.5.
 */
export const agentAuthAudit = sqliteTable("agent_auth_audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  action: text("action", {
    enum: ["connect", "disconnect", "refresh", "hydrate", "capture"],
  }).notNull(),
  toolId: text("tool_id").notNull(),
  // Intentionally no FK: audit survives session deletion.
  sessionId: text("session_id"),
  ok: integer("ok", { mode: "boolean" }).notNull().default(true),
  error: text("error"),
});

/**
 * Latest-version cache populated by the server-side npm-registry poller.
 * One row per catalog package id (text PK). Not user-scoped — version
 * info is identical for every user on this AgentHub install.
 *
 * On every poll tick:
 *   - success: latestVersion set, error cleared
 *   - failure: latestVersion left at last-good value, error populated
 */
export const packageVersionCache = sqliteTable("package_version_cache", {
  packageId: text("package_id").primaryKey(),
  latestVersion: text("latest_version"),
  checkedAt: integer("checked_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  error: text("error"),
});

/**
 * Latest-version cache populated by the image-registry poller. One row per
 * logical image (`traefik` | `postgres` | `redis` | `infisical`). Not user-
 * scoped — pin state is install-wide.
 *
 * On every poll tick:
 *   - success: newest* columns set (or upstreamDigest for digest mode),
 *     lastError cleared
 *   - failure: newest* / digest left at last-good, lastError populated
 */
export const imageVersionCache = sqliteTable("image_version_cache", {
  image: text("image").primaryKey(),
  pinnedTag: text("pinned_tag").notNull(),
  newestWithinMajor: text("newest_within_major"),
  newestAcrossMajor: text("newest_across_major"),
  upstreamDigest: text("upstream_digest"),
  lastCheckedAt: integer("last_checked_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastError: text("last_error"),
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
export type InstallBackupConfig = typeof installBackupConfig.$inferSelect;
export type InstallBackupRun = typeof installBackupRuns.$inferSelect;
export type NewInstallBackupRun = typeof installBackupRuns.$inferInsert;
export type AgentAuthAudit = typeof agentAuthAudit.$inferSelect;
export type NewAgentAuthAudit = typeof agentAuthAudit.$inferInsert;
export type PackageVersionCache = typeof packageVersionCache.$inferSelect;
export type NewPackageVersionCache = typeof packageVersionCache.$inferInsert;
export type ImageVersionCache = typeof imageVersionCache.$inferSelect;
export type NewImageVersionCache = typeof imageVersionCache.$inferInsert;
