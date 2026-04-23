import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { hashSync } from "bcryptjs";
import * as schema from "./schema.js";

const DB_PATH = process.env["DB_PATH"] ?? "/data/agenthub.db";

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

export function initDb(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'creating',
      status_detail TEXT DEFAULT '',
      user_id TEXT REFERENCES users(id),
      workspace_id TEXT,
      workspace_host TEXT,
      workspace_ip TEXT,
      provider_id TEXT,
      agent_token TEXT,
      repo TEXT,
      prompt TEXT,
      created_at INTEGER NOT NULL,
      ended_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_credentials (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      claude_credentials TEXT,
      backup_config TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_session_tokens_user ON session_tokens(user_id);

    CREATE TABLE IF NOT EXISTS infrastructure_configs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL,
      config TEXT NOT NULL,
      hosting_node_ip TEXT,
      hosting_node_id TEXT,
      hosting_node_node TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      status_detail TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      infra_id TEXT NOT NULL REFERENCES infrastructure_configs(id),
      name TEXT NOT NULL,
      domain TEXT,
      internal_only INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'deploying',
      status_detail TEXT,
      url TEXT,
      container_id TEXT,
      source_path TEXT,
      compose_config TEXT,
      git_url TEXT,
      git_branch TEXT,
      build_strategy TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_infra_configs_user ON infrastructure_configs(user_id);
    CREATE INDEX IF NOT EXISTS idx_deployments_user ON deployments(user_id);
    CREATE INDEX IF NOT EXISTS idx_deployments_infra ON deployments(infra_id);

    CREATE TABLE IF NOT EXISTS backup_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      bytes INTEGER,
      file_count INTEGER,
      snapshot_at INTEGER,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_backup_runs_user_started ON backup_runs(user_id, started_at);

    CREATE TABLE IF NOT EXISTS user_packages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      package_id TEXT NOT NULL,
      status TEXT NOT NULL,
      version TEXT,
      installed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      error TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_packages_user_package
      ON user_packages(user_id, package_id);
  `);

  // Idempotent schema migrations for existing installs — SQLite has no
  // `ADD COLUMN IF NOT EXISTS`, so we try-and-ignore "duplicate column".
  // Each call is a no-op on fresh DBs (already in the CREATE TABLE above)
  // and a one-time backfill on upgraded DBs.
  addColumnIfMissing("deployments", "git_url", "TEXT");
  addColumnIfMissing("deployments", "git_branch", "TEXT");
  addColumnIfMissing("deployments", "build_strategy", "TEXT");

  // Seed default admin account. Password priority:
  //   1. AGENTHUB_ADMIN_PASSWORD env var (installer writes this into .env)
  //   2. random UUID slice if unset — surfaces once in stdout, must be rotated
  const adminExists = sqlite
    .prepare("SELECT 1 FROM users WHERE username = 'admin'")
    .get();
  if (!adminExists) {
    const id = randomUUID();
    const envPassword = process.env["AGENTHUB_ADMIN_PASSWORD"];
    const password = envPassword && envPassword.length >= 8
      ? envPassword
      : randomUUID().slice(0, 16);
    const hash = hashSync(password, 12);
    sqlite
      .prepare(
        "INSERT INTO users (id, username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, "admin", hash, "Admin", "admin", Date.now());
    if (envPassword && envPassword.length >= 8) {
      console.log("[db] seeded admin account — password from AGENTHUB_ADMIN_PASSWORD env");
    } else {
      console.log(`[db] seeded admin account — password: ${password}`);
      console.log("[db] CHANGE THIS PASSWORD IMMEDIATELY via Settings > Change Password");
    }
  }

  const deleted = sqlite
    .prepare("DELETE FROM session_tokens WHERE expires_at < ?")
    .run(Date.now());
  if (deleted.changes > 0) {
    console.log(`[db] cleaned up ${String(deleted.changes)} expired session token(s)`);
  }
}

function addColumnIfMissing(table: string, column: string, type: string): void {
  try {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // SQLite's error message on duplicate: "duplicate column name: <name>"
    if (!/duplicate column name/i.test(msg)) {
      console.warn(`[db] ADD COLUMN ${table}.${column} failed: ${msg}`);
    }
  }
}

setInterval(() => {
  try {
    sqlite.prepare("DELETE FROM session_tokens WHERE expires_at < ?").run(Date.now());
  } catch {
    // DB may be closed during shutdown
  }
}, 3_600_000);

export { schema };
