import { describe, expect, it } from "vitest";
import {
  applyEnvOverrides,
  emptyConfig,
  missingRequiredForHeadless,
  renderEnv,
} from "./config.js";

describe("emptyConfig", () => {
  it("generates distinct random passwords per call", () => {
    const a = emptyConfig();
    const b = emptyConfig();
    expect(a.infisicalDbPassword).not.toBe(b.infisicalDbPassword);
    expect(a.infisicalAuthSecret).not.toBe(b.infisicalAuthSecret);
    expect(a.infisicalEncryptionKey).not.toBe(b.infisicalEncryptionKey);
  });

  it("generates Infisical encryption key at 16 bytes hex (32 chars)", () => {
    const cfg = emptyConfig();
    expect(cfg.infisicalEncryptionKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it("defaults mode=docker and domain=localhost", () => {
    const cfg = emptyConfig();
    expect(cfg.mode).toBe("docker");
    expect(cfg.domain).toBe("localhost");
  });
});

describe("renderEnv", () => {
  it("produces a complete docker-compose .env", () => {
    const cfg = emptyConfig();
    cfg.domain = "example.com";
    cfg.tlsEmail = "ops@example.com";
    cfg.mode = "docker";
    cfg.adminPassword = "hunter2";

    const env = renderEnv(cfg);

    expect(env).toContain("DOMAIN=example.com");
    expect(env).toContain("TLS_EMAIL=ops@example.com");
    expect(env).toContain("PROVISIONER_MODE=docker");
    expect(env).toContain("AGENTHUB_ADMIN_PASSWORD=hunter2");
    expect(env).toContain(`INFISICAL_ENCRYPTION_KEY=${cfg.infisicalEncryptionKey}`);
  });

  it("emits Dokploy fields even when blank (for remote mode toggling)", () => {
    const cfg = emptyConfig();
    const env = renderEnv(cfg);
    expect(env).toContain("DOKPLOY_URL=");
    expect(env).toContain("DOKPLOY_API_TOKEN=");
  });

  it("uses a permissive PathPrefix host rule for localhost installs", () => {
    const cfg = emptyConfig();
    cfg.domain = "localhost";
    const env = renderEnv(cfg);
    expect(env).toContain("AGENTHUB_HOST_RULE=PathPrefix(`/`)");
  });

  it("uses a strict Host() rule for real-domain installs", () => {
    const cfg = emptyConfig();
    cfg.domain = "agents.acme.io";
    const env = renderEnv(cfg);
    expect(env).toContain("AGENTHUB_HOST_RULE=Host(`agents.acme.io`)");
  });

  it("emits AGENTHUB_PUBLIC_HOST (blank by default — compose falls back to DOMAIN)", () => {
    const cfg = emptyConfig();
    const env = renderEnv(cfg);
    expect(env).toContain("AGENTHUB_PUBLIC_HOST=");
  });

  it("carries an explicit publicHost through to the env file", () => {
    const cfg = emptyConfig();
    cfg.publicHost = "192.168.1.42";
    const env = renderEnv(cfg);
    expect(env).toContain("AGENTHUB_PUBLIC_HOST=192.168.1.42");
  });

  it("emits AGENTHUB_OWNER blank by default", () => {
    const cfg = emptyConfig();
    const env = renderEnv(cfg);
    expect(env).toContain("AGENTHUB_OWNER=");
  });

  it("carries an explicit ownerUidGid through to the env file", () => {
    const cfg = emptyConfig();
    cfg.ownerUidGid = "1000:1000";
    const env = renderEnv(cfg);
    expect(env).toContain("AGENTHUB_OWNER=1000:1000");
  });
});

describe("applyEnvOverrides", () => {
  it("pulls documented AGENTHUB_* vars onto the config", () => {
    const cfg = emptyConfig();
    const out = applyEnvOverrides(cfg, {
      AGENTHUB_MODE: "dokploy-remote",
      AGENTHUB_DOMAIN: "agents.acme.io",
      AGENTHUB_TLS_EMAIL: "foo@acme.io",
      AGENTHUB_ADMIN_PASSWORD: "shhh",
      AGENTHUB_DOKPLOY_URL: "https://dokploy.acme.io",
      AGENTHUB_DOKPLOY_API_TOKEN: "tok",
      AGENTHUB_DOKPLOY_PROJECT_ID: "proj",
      AGENTHUB_DOKPLOY_ENVIRONMENT_ID: "env",
      AGENTHUB_PUBLIC_HOST: "10.0.0.5",
      AGENTHUB_OWNER: "1000:1000",
    });
    expect(out.mode).toBe("dokploy-remote");
    expect(out.domain).toBe("agents.acme.io");
    expect(out.tlsEmail).toBe("foo@acme.io");
    expect(out.adminPassword).toBe("shhh");
    expect(out.dokployUrl).toBe("https://dokploy.acme.io");
    expect(out.dokployEnvironmentId).toBe("env");
    expect(out.publicHost).toBe("10.0.0.5");
    expect(out.ownerUidGid).toBe("1000:1000");
  });

  it("leaves unrelated fields alone", () => {
    const cfg = emptyConfig();
    const original = cfg.infisicalEncryptionKey;
    const out = applyEnvOverrides(cfg, { AGENTHUB_DOMAIN: "x" });
    expect(out.infisicalEncryptionKey).toBe(original);
  });
});

describe("missingRequiredForHeadless", () => {
  it("is empty for a valid docker+localhost config", () => {
    const cfg = emptyConfig();
    cfg.adminPassword = "x";
    expect(missingRequiredForHeadless(cfg)).toEqual([]);
  });

  it("demands TLS email when domain != localhost", () => {
    const cfg = emptyConfig();
    cfg.domain = "agents.acme.io";
    expect(missingRequiredForHeadless(cfg)).toContain("AGENTHUB_TLS_EMAIL");
  });

  it("demands all four Dokploy-remote vars", () => {
    const cfg = emptyConfig();
    cfg.mode = "dokploy-remote";
    const missing = missingRequiredForHeadless(cfg);
    expect(missing).toContain("AGENTHUB_DOKPLOY_URL");
    expect(missing).toContain("AGENTHUB_DOKPLOY_API_TOKEN");
    expect(missing).toContain("AGENTHUB_DOKPLOY_PROJECT_ID");
    expect(missing).toContain("AGENTHUB_DOKPLOY_ENVIRONMENT_ID");
  });
});
