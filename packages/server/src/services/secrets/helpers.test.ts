import { describe, expect, it } from "vitest";
import { splitSecrets, infraSecretPath } from "./helpers.js";

describe("splitSecrets", () => {
  it("moves Cloudflare apiToken to secrets and keeps zoneId as metadata", () => {
    const { metadata, secrets } = splitSecrets("cloudflare", {
      apiToken: "cf_abc123",
      zoneId: "zone_42",
    });
    expect(secrets).toEqual({ apiToken: "cf_abc123" });
    expect(metadata).toEqual({ zoneId: "zone_42" });
  });

  it("moves Docker sshPrivateKey to secrets", () => {
    const { metadata, secrets } = splitSecrets("docker", {
      hostIp: "1.2.3.4",
      sshUser: "root",
      sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END",
    });
    expect(Object.keys(secrets)).toEqual(["sshPrivateKey"]);
    expect(metadata).toEqual({ hostIp: "1.2.3.4", sshUser: "root" });
  });

  it("ignores non-string values in secret positions", () => {
    const { metadata, secrets } = splitSecrets("cloudflare", {
      apiToken: 123, // should NOT be coerced to secrets
      zoneId: "zone_x",
    });
    expect(secrets).toEqual({});
    expect(metadata).toEqual({ apiToken: 123, zoneId: "zone_x" });
  });

  it("unknown providers treat every field as metadata (safe default)", () => {
    const { metadata, secrets } = splitSecrets("unknown", {
      apiToken: "abc",
      other: "x",
    });
    expect(secrets).toEqual({});
    expect(metadata).toEqual({ apiToken: "abc", other: "x" });
  });

  it("AI providers split apiKey to secrets, keep baseUrl in metadata", () => {
    const { metadata, secrets } = splitSecrets("ai-minimax", {
      apiKey: "mm_secret",
      baseUrl: "https://api.minimax.io/anthropic",
    });
    expect(secrets).toEqual({ apiKey: "mm_secret" });
    expect(metadata).toEqual({ baseUrl: "https://api.minimax.io/anthropic" });
  });

  it("ai-anthropic and ai-openai split apiKey only", () => {
    for (const provider of ["ai-anthropic", "ai-openai"] as const) {
      const { metadata, secrets } = splitSecrets(provider, { apiKey: "k" });
      expect(secrets).toEqual({ apiKey: "k" });
      expect(metadata).toEqual({});
    }
  });
});

describe("infraSecretPath", () => {
  it("forms deterministic user/infra path", () => {
    expect(infraSecretPath("user-1", "infra-A")).toBe("/users/user-1/infra/infra-A");
  });
});
