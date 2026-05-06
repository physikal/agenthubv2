import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertEnvVars } from "./reconfigure.js";

describe("upsertEnvVars", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agenthub-reconfigure-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("adds COMPOSE_FILE when .env doesn't have it (localhost-origin install)", () => {
    writeFileSync(join(tmp, ".env"), "DOMAIN=agenthub-test.lan\nTLS_EMAIL=\n");
    upsertEnvVars(tmp, {
      COMPOSE_FILE: "docker-compose.yml:traefik.override.yml",
    });
    const text = readFileSync(join(tmp, ".env"), "utf8");
    expect(text).toContain("DOMAIN=agenthub-test.lan");
    expect(text).toContain(
      "COMPOSE_FILE=docker-compose.yml:traefik.override.yml",
    );
  });

  it("replaces an existing COMPOSE_FILE without duplicating it", () => {
    writeFileSync(
      join(tmp, ".env"),
      "DOMAIN=foo.com\nCOMPOSE_FILE=docker-compose.yml\n",
    );
    upsertEnvVars(tmp, {
      COMPOSE_FILE: "docker-compose.yml:traefik.override.yml",
    });
    const text = readFileSync(join(tmp, ".env"), "utf8");
    const matches = text.match(/^COMPOSE_FILE=/gm) ?? [];
    expect(matches).toHaveLength(1);
    expect(text).toContain(
      "COMPOSE_FILE=docker-compose.yml:traefik.override.yml",
    );
  });

  it("merges DNS env vars alongside COMPOSE_FILE", () => {
    writeFileSync(join(tmp, ".env"), "DOMAIN=foo.com\n");
    upsertEnvVars(tmp, {
      COMPOSE_FILE: "docker-compose.yml:traefik.override.yml",
      CF_DNS_API_TOKEN: "secret-123",
    });
    const text = readFileSync(join(tmp, ".env"), "utf8");
    expect(text).toContain(
      "COMPOSE_FILE=docker-compose.yml:traefik.override.yml",
    );
    expect(text).toContain("CF_DNS_API_TOKEN=secret-123");
    expect(text).toContain("DOMAIN=foo.com");
  });

  it("creates .env if missing (defensive — installs always have one)", () => {
    upsertEnvVars(tmp, {
      COMPOSE_FILE: "docker-compose.yml:traefik.override.yml",
    });
    const text = readFileSync(join(tmp, ".env"), "utf8");
    expect(text).toContain(
      "COMPOSE_FILE=docker-compose.yml:traefik.override.yml",
    );
  });
});
