import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EnvOverrides,
} from "./env-overrides.js";

describe("EnvOverrides", () => {
  let dir: string;
  let env: EnvOverrides;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "envov-"));
    writeFileSync(join(dir, ".env"), "FOO=bar\n# comment\nBAZ=qux\n");
    env = new EnvOverrides({ envPath: join(dir, ".env") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("readPin returns the override when set, falling back to the default", () => {
    writeFileSync(join(dir, ".env"), "TRAEFIK_IMAGE=traefik:v3.7\n");
    expect(env.readPin("traefik")).toBe("traefik:v3.7");
    // Postgres has no override → falls back to catalog default
    expect(env.readPin("postgres")).toBe("postgres:16-alpine");
  });

  it("writePin upserts in place, preserves other keys + comments + trailing newline", () => {
    env.writePin("traefik", "traefik:v3.7.1");
    const after = readFileSync(join(dir, ".env"), "utf8");
    expect(after).toContain("FOO=bar");
    expect(after).toContain("# comment");
    expect(after).toContain("BAZ=qux");
    expect(after).toContain("TRAEFIK_IMAGE=traefik:v3.7.1");
    expect(after.endsWith("\n")).toBe(true);
  });

  it("writePin replaces an existing override line without duplicating it", () => {
    writeFileSync(join(dir, ".env"), "TRAEFIK_IMAGE=traefik:v3.6\nFOO=bar\n");
    env.writePin("traefik", "traefik:v3.7.1");
    const after = readFileSync(join(dir, ".env"), "utf8");
    const matches = after.match(/^TRAEFIK_IMAGE=/gm) ?? [];
    expect(matches).toHaveLength(1);
    expect(after).toContain("TRAEFIK_IMAGE=traefik:v3.7.1");
    expect(after).toContain("FOO=bar");
  });

  it("backupEnv creates a timestamped copy", () => {
    const backupPath = env.backupEnv();
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, "utf8")).toBe(readFileSync(join(dir, ".env"), "utf8"));
  });

  it("restoreEnv reverts to the backup contents", () => {
    const backupPath = env.backupEnv();
    writeFileSync(join(dir, ".env"), "BROKEN=true\n");
    env.restoreEnv(backupPath);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("FOO=bar\n# comment\nBAZ=qux\n");
  });

  it("pruneOldBackups keeps the N newest", () => {
    // Create 5 backups with deliberate name ordering
    env.backupEnv();
    env.backupEnv();
    env.backupEnv();
    env.backupEnv();
    env.backupEnv();
    env.pruneOldBackups(2);
    const remaining = readdirSync(dir).filter((f) => f.startsWith(".env.bak-"));
    expect(remaining).toHaveLength(2);
  });
});
