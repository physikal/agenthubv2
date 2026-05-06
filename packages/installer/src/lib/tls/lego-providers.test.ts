import { describe, it, expect } from "vitest";
import { requiredEnvVarsFor, knownProviders } from "./lego-providers.js";

describe("lego-providers", () => {
  it("returns Cloudflare's env var", () => {
    expect(requiredEnvVarsFor("cloudflare")).toEqual(["CF_DNS_API_TOKEN"]);
  });

  it("returns Route53's env vars", () => {
    expect(requiredEnvVarsFor("route53")).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_REGION",
    ]);
  });

  it("returns null for unknown providers (caller decides how to handle)", () => {
    expect(requiredEnvVarsFor("totally-fake-provider")).toBeNull();
  });

  it("knownProviders includes the seed list", () => {
    expect(knownProviders()).toEqual(
      expect.arrayContaining([
        "cloudflare",
        "route53",
        "digitalocean",
        "hetzner",
        "gandi",
        "linode",
      ]),
    );
  });
});
