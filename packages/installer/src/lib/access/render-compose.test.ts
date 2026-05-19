import { describe, it, expect } from "vitest";
import {
  renderTraefikStaticConfig,
  renderTraefikOverride,
  renderRedirectDynamic,
} from "./render-compose.js";

describe("renderTraefikStaticConfig", () => {
  it("lan: emits web + infisical entrypoints, no cert resolver, no websecure", () => {
    const yaml = renderTraefikStaticConfig({
      accessMode: "lan",
      domain: "192.168.1.5",
      publicTlsMode: undefined,
      tlsEmail: "",
    });
    expect(yaml).toContain("entryPoints:");
    expect(yaml).toContain("web:");
    expect(yaml).toContain(":80");
    // infisical entrypoint on :8443 (plain HTTP in lan mode). Without
    // this the Infisical admin console is unreachable.
    expect(yaml).toContain("infisical:");
    expect(yaml).toContain(":8443");
    expect(yaml).not.toContain("websecure");
    expect(yaml).not.toContain("certificatesResolvers");
    expect(yaml).not.toContain(":443");
  });

  it("public + public-alpn: emits web + websecure + infisical entrypoints, tlsChallenge resolver", () => {
    const yaml = renderTraefikStaticConfig({
      accessMode: "public",
      domain: "agenthub.example.com",
      publicTlsMode: "public-alpn",
      tlsEmail: "ops@example.com",
    });
    expect(yaml).toContain("web:");
    expect(yaml).toContain("websecure:");
    expect(yaml).toContain("infisical:");
    expect(yaml).toContain(":80");
    expect(yaml).toContain(":443");
    expect(yaml).toContain(":8443");
    expect(yaml).toContain("certificatesResolvers:");
    expect(yaml).toContain("tlsChallenge: {}");
    expect(yaml).toContain("email: ops@example.com");
  });

  it("public + dns-01: emits dnsChallenge resolver with provider", () => {
    const yaml = renderTraefikStaticConfig({
      accessMode: "public",
      domain: "agenthub.example.com",
      publicTlsMode: "dns-01",
      tlsEmail: "ops@example.com",
      dnsProvider: "cloudflare",
    });
    expect(yaml).toContain("dnsChallenge:");
    expect(yaml).toContain("provider: cloudflare");
  });

  it("throws when public mode is missing tlsEmail", () => {
    expect(() =>
      renderTraefikStaticConfig({
        accessMode: "public",
        domain: "agenthub.example.com",
        publicTlsMode: "public-alpn",
        tlsEmail: "",
      }),
    ).toThrow(/AGENTHUB_TLS_EMAIL/);
  });

  it("throws when public+dns-01 is missing dnsProvider", () => {
    expect(() =>
      renderTraefikStaticConfig({
        accessMode: "public",
        domain: "agenthub.example.com",
        publicTlsMode: "dns-01",
        tlsEmail: "ops@example.com",
      }),
    ).toThrow(/dnsProvider/);
  });
});

describe("renderTraefikOverride", () => {
  it("lan: returns null (no override needed)", () => {
    expect(
      renderTraefikOverride({
        accessMode: "lan",
        domain: "192.168.1.5",
        publicTlsMode: undefined,
        tlsEmail: "",
      }),
    ).toBeNull();
  });

  it("public + public-alpn: adds tls=true + certresolver labels to agenthub-server", () => {
    const yaml = renderTraefikOverride({
      accessMode: "public",
      domain: "agenthub.example.com",
      publicTlsMode: "public-alpn",
      tlsEmail: "ops@example.com",
    });
    expect(yaml).not.toBeNull();
    expect(yaml!).toContain("agenthub-server");
    // tls=true must be in the override (NOT base compose) so lan mode
    // doesn't accidentally attach TLS to the plain :80 entrypoint.
    expect(yaml!).toContain("traefik.http.routers.agenthub.tls=true");
    expect(yaml!).toContain("traefik.http.routers.agenthub.tls.certresolver=le");
  });

  it("public + dns-01: adds DNS env vars on traefik service + certresolver label", () => {
    const yaml = renderTraefikOverride({
      accessMode: "public",
      domain: "agenthub.example.com",
      publicTlsMode: "dns-01",
      tlsEmail: "ops@example.com",
      dnsProvider: "cloudflare",
      dnsEnvVars: { CF_DNS_API_TOKEN: "${CF_DNS_API_TOKEN}" },
    });
    expect(yaml).not.toBeNull();
    expect(yaml!).toContain("CF_DNS_API_TOKEN");
    expect(yaml!).toContain("certresolver=le");
    // Host-side ports are env-templated so operators can co-locate.
    expect(yaml!).toMatch(/AGENTHUB_HTTP_PORT.*:80/);
    expect(yaml!).toMatch(/AGENTHUB_HTTPS_PORT.*:443/);
  });

  it("public: restates :80, :443, :8443 on traefik.ports so compose merge doesn't drop :80", () => {
    const yaml = renderTraefikOverride({
      accessMode: "public",
      domain: "agenthub.example.com",
      publicTlsMode: "public-alpn",
      tlsEmail: "ops@example.com",
    });
    expect(yaml).not.toBeNull();
    // Host-side ports use env-var templates with sane defaults.
    expect(yaml!).toMatch(/AGENTHUB_HTTP_PORT.*:80/);
    expect(yaml!).toMatch(/AGENTHUB_HTTPS_PORT.*:443/);
    expect(yaml!).toMatch(/AGENTHUB_INFISICAL_PORT.*:8443/);
  });

  it("never emits `command:` on the traefik service (regression guard for #69)", () => {
    const alpnYaml = renderTraefikOverride({
      accessMode: "public",
      domain: "agenthub.example.com",
      publicTlsMode: "public-alpn",
      tlsEmail: "ops@example.com",
    });
    expect(alpnYaml).not.toBeNull();
    expect(alpnYaml!).not.toMatch(/^\s+command:/m);

    const dnsYaml = renderTraefikOverride({
      accessMode: "public",
      domain: "agenthub.example.com",
      publicTlsMode: "dns-01",
      tlsEmail: "ops@example.com",
      dnsProvider: "cloudflare",
      dnsEnvVars: { CF_DNS_API_TOKEN: "${CF_DNS_API_TOKEN}" },
    });
    expect(dnsYaml).not.toBeNull();
    expect(dnsYaml!).not.toMatch(/^\s+command:/m);
  });
});

describe("renderRedirectDynamic", () => {
  it("lan: returns null (no redirect needed; no HTTPS to redirect to)", () => {
    expect(renderRedirectDynamic({ accessMode: "lan" })).toBeNull();
  });

  it("public: emits HTTP→HTTPS redirect middleware", () => {
    const yaml = renderRedirectDynamic({ accessMode: "public" });
    expect(yaml).not.toBeNull();
    expect(yaml!).toContain("redirectScheme:");
    expect(yaml!).toContain("scheme: https");
  });
});
