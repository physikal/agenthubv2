import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateTlsConfig } from "./migrate.js";

describe("migrateTlsConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agenthub-migrate-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op when override already exists", () => {
    writeFileSync(join(dir, ".env"), "DOMAIN=foo.com\nTLS_EMAIL=x@y.com\n");
    writeFileSync(join(dir, "traefik.override.yml"), "services: {}\n");
    const result = migrateTlsConfig(dir);
    expect(result.action).toBe("noop-already-migrated");
  });

  it("is a no-op for localhost installs", () => {
    writeFileSync(join(dir, ".env"), "DOMAIN=localhost\n");
    const result = migrateTlsConfig(dir);
    expect(result.action).toBe("noop-localhost");
    expect(existsSync(join(dir, "traefik.override.yml"))).toBe(false);
  });

  it("infers public-alpn for real domain with TLS_EMAIL", () => {
    writeFileSync(join(dir, ".env"), "DOMAIN=foo.com\nTLS_EMAIL=x@y.com\n");
    const result = migrateTlsConfig(dir);
    expect(result.action).toBe("migrated");
    expect(result.inferredMode).toBe("public-alpn");
    expect(existsSync(join(dir, "traefik.override.yml"))).toBe(true);
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("COMPOSE_FILE=docker-compose.yml:traefik.override.yml");
  });

  it("preserves other .env lines verbatim", () => {
    const original = "DOMAIN=foo.com\nTLS_EMAIL=x@y.com\nINFISICAL_PROJECT_ID=abc\n";
    writeFileSync(join(dir, ".env"), original);
    migrateTlsConfig(dir);
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("INFISICAL_PROJECT_ID=abc");
    expect(env).toContain("DOMAIN=foo.com");
  });

  it("throws when real-domain install has no TLS_EMAIL", () => {
    writeFileSync(join(dir, ".env"), "DOMAIN=foo.com\n");
    expect(() => migrateTlsConfig(dir)).toThrow(/TLS_EMAIL/);
  });
});
