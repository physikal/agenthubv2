import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdirSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { migrateAccessConfig } from "./migrate.js";

function setupFixture(
  envContents: string,
  overrideContents?: string,
  traefikYmlContents?: string,
  redirectYmlContents?: string,
): string {
  const dir = mkdtempSync(join(tmpdir(), "migrate-access-"));
  writeFileSync(join(dir, ".env"), envContents);
  if (overrideContents !== undefined) {
    writeFileSync(join(dir, "traefik.override.yml"), overrideContents);
  }
  if (traefikYmlContents !== undefined) {
    writeFileSync(join(dir, "traefik.yml"), traefikYmlContents);
  }
  if (redirectYmlContents !== undefined) {
    const dynamicDir = join(dir, "dynamic");
    mkdirSync(dynamicDir, { recursive: true });
    writeFileSync(join(dynamicDir, "redirect.yml"), redirectYmlContents);
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

  // VM 923 in prod was on self-CA but its .env never had an explicit
  // AGENTHUB_TLS_MODE=self-ca line (the mode was implied at install time
  // via process env). The original migration logic defaulted to "auto" and
  // routed those installs to the wrong (public) path. Detect self-CA via
  // AGENTHUB_LAN_IP presence (self-CA-only variable) as a fallback.
  it("implicit self-ca (no TLS_MODE but LAN_IP set) → lan", () => {
    const dir = setupFixture(
      [
        "DOMAIN=agenthub.example.com",
        "AGENTHUB_LAN_IP=192.168.4.221",
        "COMPOSE_FILE=docker-compose.yml:traefik.override.yml",
      ].join("\n"),
      "services:\n  traefik-self-ca-init:\n    image: alpine:3.20\n",
    );
    const r = migrateAccessConfig(dir);
    expect(r.action).toBe("migrated-self-ca-to-lan");
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("AGENTHUB_ACCESS_MODE=lan");
    expect(env).toContain("AGENTHUB_PUBLIC_URL=http://agenthub.example.com");
    expect(env).not.toMatch(/AGENTHUB_LAN_IP=/);
    expect(env).not.toMatch(/COMPOSE_FILE=/);
    rmSync(dir, { recursive: true });
  });

  it("self-ca → lan: regenerates traefik.yml as lan-only (no websecure, no certificatesResolvers)", () => {
    // Simulate a VM 923 self-CA install with the stale self-CA traefik.yml.
    const staleTraefikYml = [
      "entryPoints:",
      "  web:",
      "    address: ':80'",
      "  websecure:",
      "    address: ':443'",
      "certificatesResolvers:",
      "  selfCA:",
      "    acme:",
      "      email: ops@example.com",
    ].join("\n");
    const dir = setupFixture(
      [
        "DOMAIN=agenthub.example.com",
        "AGENTHUB_TLS_MODE=self-ca",
        "AGENTHUB_LAN_IP=192.168.1.5",
        "COMPOSE_FILE=docker-compose.yml:traefik.override.yml",
      ].join("\n"),
      "services:\n  traefik-self-ca-init:\n    image: alpine:3.20\n",
      staleTraefikYml,
      // pre-existing redirect.yml to confirm it is deleted
      "http:\n  middlewares:\n    redirect-to-https:\n      redirectScheme:\n        scheme: https\n",
    );

    const r = migrateAccessConfig(dir);
    expect(r.action).toBe("migrated-self-ca-to-lan");

    // traefik.yml must be rewritten for lan mode
    const traefikYml = readFileSync(join(dir, "traefik.yml"), "utf8");
    expect(traefikYml).toContain("web:");
    expect(traefikYml).not.toContain("websecure:");
    expect(traefikYml).not.toContain("certificatesResolvers:");

    // dynamic/redirect.yml must be deleted (no HTTPS on lan)
    expect(existsSync(join(dir, "dynamic", "redirect.yml"))).toBe(false);

    rmSync(dir, { recursive: true });
  });

  it("public-alpn → public+public-alpn: regenerates traefik.yml and redirect.yml", () => {
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

    // traefik.yml must have websecure + certificatesResolvers for public mode
    const traefikYml = readFileSync(join(dir, "traefik.yml"), "utf8");
    expect(traefikYml).toContain("web:");
    expect(traefikYml).toContain("websecure:");
    expect(traefikYml).toContain("certificatesResolvers:");
    expect(traefikYml).toContain("tlsChallenge:");

    // dynamic/redirect.yml must exist for public mode
    expect(existsSync(join(dir, "dynamic", "redirect.yml"))).toBe(true);
    const redirectYml = readFileSync(join(dir, "dynamic", "redirect.yml"), "utf8");
    expect(redirectYml).toContain("redirect-to-https:");

    rmSync(dir, { recursive: true });
  });
});
