// Run before any test file imports a module — ensures src/db/index.ts uses an
// in-memory SQLite instead of trying to open /data/agenthub.db in environments
// without that path (dev machines, CI).
if (!process.env["DB_PATH"]) {
  process.env["DB_PATH"] = ":memory:";
}
