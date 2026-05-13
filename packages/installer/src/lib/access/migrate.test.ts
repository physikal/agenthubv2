import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { migrateAccessConfig } from "./migrate.js";

function setupFixture(envContents: string, overrideContents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "migrate-access-"));
  writeFileSync(join(dir, ".env"), envContents);
  if (overrideContents !== undefined) {
    writeFileSync(join(dir, "traefik.override.yml"), overrideContents);
  }
  return dir;
}

describe("migrateAccessConfig", () => {
  it("self-ca → lan: rewrites .env, deletes self-CA artifacts from override", () => {
    const dir = setupFixture(
      [
        "DOMAIN=agenthub.example.com",
        "AGENTHUB_TLS_MODE=self-ca",
        "AGENTHUB_LAN_IP=192.168.1.5",
        "COMPOSE_FILE=docker-compose.yml:traefik.override.yml",
      ].join("\n"),
      "services:\n  traefik-self-ca-init:\n    image: alpine:3.20\n",
    );
    const r = migrateAccessConfig(dir);
    expect(r.action).toBe("migrated-self-ca-to-lan");
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("AGENTHUB_ACCESS_MODE=lan");
    expect(env).toContain("AGENTHUB_PUBLIC_URL=http://agenthub.example.com");
    expect(env).not.toMatch(/AGENTHUB_TLS_MODE=self-ca/);
    expect(env).not.toMatch(/COMPOSE_FILE=.*traefik\.override\.yml/);
    expect(existsSync(join(dir, "traefik.override.yml"))).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it("public-alpn → public+public-alpn: keeps tlsMode as sub-mode", () => {
    const dir = setupFixture(
      [
        "DOMAIN=agenthub.example.com",
        "AGENTHUB_TLS_MODE=public-alpn",
        "AGENTHUB_TLS_EMAIL=ops@example.com",
        "COMPOSE_FILE=docker-compose.yml:traefik.override.yml",
      ].join("\n"),
    );
    const r = migrateAccessConfig(dir);
    expect(r.action).toBe("migrated-tls-to-public");
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("AGENTHUB_ACCESS_MODE=public");
    expect(env).toContain("AGENTHUB_TLS_MODE=public-alpn");
    expect(env).toContain("AGENTHUB_PUBLIC_URL=https://agenthub.example.com");
    rmSync(dir, { recursive: true });
  });

  it("dns-01 → public+dns-01: preserves DNS provider env vars", () => {
    const dir = setupFixture(
      [
        "DOMAIN=agenthub.example.com",
        "AGENTHUB_TLS_MODE=dns-01",
        "AGENTHUB_TLS_DNS_PROVIDER=cloudflare",
        "AGENTHUB_TLS_EMAIL=ops@example.com",
        "CF_DNS_API_TOKEN=secret",
      ].join("\n"),
    );
    const r = migrateAccessConfig(dir);
    expect(r.action).toBe("migrated-tls-to-public");
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("AGENTHUB_ACCESS_MODE=public");
    expect(env).toContain("AGENTHUB_TLS_MODE=dns-01");
    expect(env).toContain("CF_DNS_API_TOKEN=secret");
    rmSync(dir, { recursive: true });
  });

  it("DOMAIN=localhost: rewrites to lan", () => {
    const dir = setupFixture(
      ["DOMAIN=localhost", "AGENTHUB_TLS_MODE=auto"].join("\n"),
    );
    const r = migrateAccessConfig(dir);
    expect(r.action).toBe("migrated-localhost-to-lan");
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("AGENTHUB_ACCESS_MODE=lan");
    expect(env).toContain("AGENTHUB_PUBLIC_URL=http://localhost");
    rmSync(dir, { recursive: true });
  });

  it("already migrated: noop", () => {
    const dir = setupFixture(
      [
        "DOMAIN=agenthub.example.com",
        "AGENTHUB_ACCESS_MODE=lan",
        "AGENTHUB_PUBLIC_URL=http://agenthub.example.com",
      ].join("\n"),
    );
    const r = migrateAccessConfig(dir);
    expect(r.action).toBe("noop-already-migrated");
    rmSync(dir, { recursive: true });
  });

  it("self-ca migration warning includes HSTS hint", () => {
    const dir = setupFixture(
      [
        "DOMAIN=agenthub.example.com",
        "AGENTHUB_TLS_MODE=self-ca",
        "AGENTHUB_LAN_IP=192.168.1.5",
      ].join("\n"),
    );
    const r = migrateAccessConfig(dir);
    expect(r.warnings.some((w) => w.includes("HSTS"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("chrome://net-internals/#hsts"))).toBe(true);
    rmSync(dir, { recursive: true });
  });
});
