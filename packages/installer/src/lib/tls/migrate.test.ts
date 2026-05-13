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

  it("brand-new install: writes traefik.yml + override for non-localhost", () => {
    writeFileSync(join(dir, ".env"), "DOMAIN=foo.com\nTLS_EMAIL=x@y.com\n");
    const result = migrateTlsConfig(dir);
    expect(result.action).toBe("migrated-new-shape");
    expect(result.inferredMode).toBe("public-alpn");
    expect(existsSync(join(dir, "traefik.yml"))).toBe(true);
    expect(existsSync(join(dir, "traefik.override.yml"))).toBe(true);
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("COMPOSE_FILE=docker-compose.yml:traefik.override.yml");
  });

  it("brand-new install: writes traefik.yml WITHOUT override for localhost", () => {
    writeFileSync(join(dir, ".env"), "DOMAIN=localhost\n");
    const result = migrateTlsConfig(dir);
    expect(result.action).toBe("migrated-new-shape");
    expect(result.inferredMode).toBe("none");
    expect(existsSync(join(dir, "traefik.yml"))).toBe(true);
    expect(existsSync(join(dir, "traefik.override.yml"))).toBe(false);
  });

  it("OLD shape (PR #62 command-array): rewrites both files", () => {
    // Simulate an install that ran on PR #62's original code.
    writeFileSync(join(dir, ".env"), "DOMAIN=foo.com\nTLS_EMAIL=x@y.com\nCOMPOSE_FILE=docker-compose.yml:traefik.override.yml\n");
    writeFileSync(
      join(dir, "traefik.override.yml"),
      [
        "services:",
        "  traefik:",
        "    command:",
        "      - --certificatesresolvers.le.acme.tlschallenge=true",
        "      - --certificatesresolvers.le.acme.email=x@y.com",
      ].join("\n"),
    );
    const result = migrateTlsConfig(dir);
    expect(result.action).toBe("migrated-from-old-shape");
    expect(existsSync(join(dir, "traefik.yml"))).toBe(true);
    // New override no longer contains a `command:` for the traefik service.
    const newOverride = readFileSync(join(dir, "traefik.override.yml"), "utf8");
    expect(newOverride).not.toMatch(/^  traefik:[\s\S]*command:/m);
  });

  it("OLD shape (PR #69 TRAEFIK_* env vars): rewrites both files", () => {
    writeFileSync(join(dir, ".env"), "DOMAIN=foo.com\nTLS_EMAIL=x@y.com\nCOMPOSE_FILE=docker-compose.yml:traefik.override.yml\n");
    writeFileSync(
      join(dir, "traefik.override.yml"),
      [
        "services:",
        "  traefik:",
        "    environment:",
        "      TRAEFIK_CERTIFICATESRESOLVERS_LE_ACME_TLSCHALLENGE: \"true\"",
      ].join("\n"),
    );
    const result = migrateTlsConfig(dir);
    expect(result.action).toBe("migrated-from-old-shape");
    const newOverride = readFileSync(join(dir, "traefik.override.yml"), "utf8");
    // New shape doesn't put any TRAEFIK_*-prefixed env on the traefik service.
    expect(newOverride).not.toMatch(/TRAEFIK_/);
  });

  it("already migrated (traefik.yml + new-shape override): no-op", () => {
    writeFileSync(join(dir, ".env"), "DOMAIN=foo.com\nTLS_EMAIL=x@y.com\n");
    writeFileSync(join(dir, "traefik.yml"), "log:\n  level: INFO\n");
    writeFileSync(
      join(dir, "traefik.override.yml"),
      [
        "services:",
        "  agenthub-server:",
        "    labels:",
        "      - traefik.http.routers.agenthub.tls.certresolver=le",
      ].join("\n"),
    );
    const result = migrateTlsConfig(dir);
    expect(result.action).toBe("noop-already-migrated");
  });

  it("already migrated (traefik.yml + no override, localhost): no-op", () => {
    writeFileSync(join(dir, ".env"), "DOMAIN=localhost\n");
    writeFileSync(join(dir, "traefik.yml"), "log:\n  level: INFO\n");
    const result = migrateTlsConfig(dir);
    expect(result.action).toBe("noop-already-migrated");
  });

  it("preserves other .env lines verbatim", () => {
    const original = "DOMAIN=foo.com\nTLS_EMAIL=x@y.com\nINFISICAL_PROJECT_ID=abc\n";
    writeFileSync(join(dir, ".env"), original);
    migrateTlsConfig(dir);
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("INFISICAL_PROJECT_ID=abc");
    expect(env).toContain("DOMAIN=foo.com");
  });

  it("throws when public-alpn install has no TLS_EMAIL", () => {
    writeFileSync(join(dir, ".env"), "DOMAIN=foo.com\n");
    expect(() => migrateTlsConfig(dir)).toThrow(/TLS_EMAIL/);
  });

  it("self-ca install requires no TLS_EMAIL", () => {
    writeFileSync(
      join(dir, ".env"),
      "DOMAIN=foo.lan\nAGENTHUB_TLS_MODE=self-ca\nAGENTHUB_LAN_IP=192.168.1.10\n",
    );
    const result = migrateTlsConfig(dir);
    expect(result.action).toBe("migrated-new-shape");
    expect(result.inferredMode).toBe("self-ca");
  });
});
