import { describe, it, expect } from "vitest";
import { load as parseYaml } from "js-yaml";
import { renderTraefikConfig } from "./render-traefik-config.js";

describe("renderTraefikConfig", () => {
  it("none/localhost: emits base config without cert resolver or file provider", () => {
    const yaml = renderTraefikConfig({
      mode: "none",
      domain: "localhost",
      tlsEmail: "",
    });
    const cfg = parseYaml(yaml) as Record<string, unknown>;
    expect(cfg["entryPoints"]).toBeDefined();
    expect(cfg["providers"]).toEqual({ docker: { exposedByDefault: false } });
    expect(cfg["certificatesResolvers"]).toBeUndefined();
  });

  it("public-alpn: emits LE TLS-ALPN cert resolver", () => {
    const yaml = renderTraefikConfig({
      mode: "public-alpn",
      domain: "agenthub.example.com",
      tlsEmail: "ops@example.com",
    });
    expect(yaml).not.toBeNull();
    const cfg = parseYaml(yaml!) as Record<string, unknown>;
    expect(cfg["certificatesResolvers"]).toEqual({
      le: {
        acme: {
          tlsChallenge: {},
          email: "ops@example.com",
          storage: "/letsencrypt/acme.json",
        },
      },
    });
  });

  it("public-alpn: throws when tlsEmail is empty", () => {
    expect(() =>
      renderTraefikConfig({
        mode: "public-alpn",
        domain: "agenthub.example.com",
        tlsEmail: "",
      }),
    ).toThrow(/AGENTHUB_TLS_EMAIL/);
  });

  it("dns-01: emits DNS-challenge resolver with provider name", () => {
    const yaml = renderTraefikConfig({
      mode: "dns-01",
      domain: "agenthub.example.com",
      tlsEmail: "ops@example.com",
      dnsProvider: "cloudflare",
    });
    const cfg = parseYaml(yaml!) as Record<string, unknown>;
    expect(cfg["certificatesResolvers"]).toEqual({
      le: {
        acme: {
          dnsChallenge: { provider: "cloudflare" },
          email: "ops@example.com",
          storage: "/letsencrypt/acme.json",
        },
      },
    });
  });

  it("dns-01: throws when dnsProvider is missing", () => {
    expect(() =>
      renderTraefikConfig({
        mode: "dns-01",
        domain: "agenthub.example.com",
        tlsEmail: "ops@example.com",
      }),
    ).toThrow(/dnsProvider/);
  });

  it("self-ca: adds file provider alongside docker provider", () => {
    const yaml = renderTraefikConfig({
      mode: "self-ca",
      domain: "agenthub.example.com",
      tlsEmail: "",
    });
    const cfg = parseYaml(yaml!) as Record<string, unknown>;
    const providers = cfg["providers"] as Record<string, unknown>;
    expect(providers["docker"]).toEqual({ exposedByDefault: false });
    expect(providers["file"]).toEqual({
      directory: "/etc/traefik/dynamic",
      watch: true,
    });
    // No cert resolvers — self-CA uses the file provider's leaf cert.
    expect(cfg["certificatesResolvers"]).toBeUndefined();
  });

  it("all modes include the redirect-to-https middleware", () => {
    const modes = ["public-alpn", "dns-01", "self-ca"] as const;
    for (const mode of modes) {
      const yaml = renderTraefikConfig({
        mode,
        domain: "agenthub.example.com",
        tlsEmail: "ops@example.com",
        dnsProvider: "cloudflare",
      });
      const cfg = parseYaml(yaml!) as Record<string, unknown>;
      const http = cfg["http"] as Record<string, unknown>;
      const middlewares = http["middlewares"] as Record<string, unknown>;
      expect(middlewares["redirect-to-https"]).toEqual({
        redirectScheme: { scheme: "https", permanent: true },
      });
    }
  });

  it("all modes set the three entrypoints (web, websecure, infisical)", () => {
    const yaml = renderTraefikConfig({
      mode: "self-ca",
      domain: "agenthub.example.com",
      tlsEmail: "",
    });
    const cfg = parseYaml(yaml!) as Record<string, unknown>;
    expect(cfg["entryPoints"]).toEqual({
      web: { address: ":80" },
      websecure: { address: ":443" },
      infisical: { address: ":8443" },
    });
  });

  it("all modes disable the API dashboard", () => {
    const yaml = renderTraefikConfig({
      mode: "self-ca",
      domain: "agenthub.example.com",
      tlsEmail: "",
    });
    const cfg = parseYaml(yaml!) as Record<string, unknown>;
    expect(cfg["api"]).toEqual({ dashboard: false });
  });
});
