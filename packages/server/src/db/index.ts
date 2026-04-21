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
  // Create core tables
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'creating',
      status_detail TEXT DEFAULT '',
      lxc_vmid INTEGER,
      lxc_node TEXT,
      lxc_ip TEXT,
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
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);
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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_infra_configs_user ON infrastructure_configs(user_id);
    CREATE INDEX IF NOT EXISTS idx_deployments_user ON deployments(user_id);
    CREATE INDEX IF NOT EXISTS idx_deployments_infra ON deployments(infra_id);

    CREATE TABLE IF NOT EXISTS pool_containers (
      vmid INTEGER PRIMARY KEY,
      node TEXT NOT NULL,
      ip TEXT,
      agent_token TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pool_containers_state ON pool_containers(state);

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
  `);

  // Migrate: add user_id column to sessions if missing
  const cols = sqlite
    .prepare("PRAGMA table_info(sessions)")
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === "user_id")) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id)");
  }

  // Index on user_id (safe to run after column exists)
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)");

  // Migrate: add name column to infrastructure_configs if missing
  const infraCols = sqlite
    .prepare("PRAGMA table_info(infrastructure_configs)")
    .all() as { name: string }[];
  if (!infraCols.some((c) => c.name === "name")) {
    sqlite.exec("ALTER TABLE infrastructure_configs ADD COLUMN name TEXT NOT NULL DEFAULT ''");
    // Backfill existing configs with provider name
    sqlite.exec("UPDATE infrastructure_configs SET name = provider WHERE name = ''");
  }

  // Migrate: add url column to deployments if missing
  const deployCols = sqlite
    .prepare("PRAGMA table_info(deployments)")
    .all() as { name: string }[];
  if (!deployCols.some((c) => c.name === "url")) {
    sqlite.exec("ALTER TABLE deployments ADD COLUMN url TEXT");
  }

  // Migrate: add backup_config column to user_credentials if missing
  const credCols = sqlite
    .prepare("PRAGMA table_info(user_credentials)")
    .all() as { name: string }[];
  if (!credCols.some((c) => c.name === "backup_config")) {
    sqlite.exec("ALTER TABLE user_credentials ADD COLUMN backup_config TEXT");
  }

  // NOTE: Active session reconnection is handled by
  // SessionManager.reconnectActiveSessions() after Proxmox client is initialized.

  // Seed default admin account with random password
  const adminExists = sqlite
    .prepare("SELECT 1 FROM users WHERE username = 'admin'")
    .get();
  if (!adminExists) {
    const id = randomUUID();
    const password = randomUUID().slice(0, 16);
    const hash = hashSync(password, 12);
    sqlite
      .prepare(
        "INSERT INTO users (id, username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, "admin", hash, "Admin", "admin", Date.now());
    console.log(`[db] seeded admin account — password: ${password}`);
    console.log("[db] CHANGE THIS PASSWORD IMMEDIATELY via Settings > Change Password");
  }

  // Clean up expired session tokens
  const deleted = sqlite
    .prepare("DELETE FROM session_tokens WHERE expires_at < ?")
    .run(Date.now());
  if (deleted.changes > 0) {
    console.log(`[db] cleaned up ${String(deleted.changes)} expired session token(s)`);
  }
}

// Periodic cleanup of expired tokens (every hour)
setInterval(() => {
  try {
    sqlite.prepare("DELETE FROM session_tokens WHERE expires_at < ?").run(Date.now());
  } catch {
    // DB may be closed during shutdown
  }
}, 3_600_000);

export { schema };
