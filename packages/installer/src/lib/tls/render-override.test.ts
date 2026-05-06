import { describe, it, expect } from "vitest";
import { load as parseYaml } from "js-yaml";
import { renderTraefikOverride } from "./render-override.js";

describe("renderTraefikOverride", () => {
  it("returns null for resolved mode 'none' (localhost)", () => {
    expect(
      renderTraefikOverride({
        mode: "none",
        domain: "localhost",
        tlsEmail: "",
      }),
    ).toBeNull();
  });

  it("renders public-alpn TLS flags via TRAEFIK_* env vars (so the override merges with the base command)", () => {
    const out = renderTraefikOverride({
      mode: "public-alpn",
      domain: "agenthub.example.com",
      tlsEmail: "ops@example.com",
    });
    expect(out).not.toBeNull();
    const parsed = parseYaml(out!) as Record<string, unknown>;
    const traefik = (parsed["services"] as Record<
      string,
      { command?: string[]; environment?: Record<string, string> }
    >)["traefik"];
    expect(traefik).toBeDefined();
    // Bug #1 regression guard: must NOT emit a `command:` array (compose
    // merge would replace the base Traefik command and lose providers/
    // entrypoints/redirect).
    expect(traefik!.command).toBeUndefined();
    expect(traefik!.environment).toEqual({
      TRAEFIK_CERTIFICATESRESOLVERS_LE_ACME_TLSCHALLENGE: "true",
      TRAEFIK_CERTIFICATESRESOLVERS_LE_ACME_EMAIL: "ops@example.com",
      TRAEFIK_CERTIFICATESRESOLVERS_LE_ACME_STORAGE: "/letsencrypt/acme.json",
    });
  });

  it("attaches cert resolver to the agenthub router via labels", () => {
    const out = renderTraefikOverride({
      mode: "public-alpn",
      domain: "agenthub.example.com",
      tlsEmail: "ops@example.com",
    });
    const parsed = parseYaml(out!) as Record<string, unknown>;
    const server = (parsed["services"] as Record<string, { labels: string[] }>)[
      "agenthub-server"
    ];
    expect(server).toBeDefined();
    expect(server!.labels).toContain(
      "traefik.http.routers.agenthub.tls.certresolver=le",
    );
  });

  it("throws when public-alpn is requested without an email", () => {
    expect(() =>
      renderTraefikOverride({
        mode: "public-alpn",
        domain: "agenthub.example.com",
        tlsEmail: "",
      }),
    ).toThrow(/AGENTHUB_TLS_EMAIL/);
  });
});

describe("renderTraefikOverride dns-01", () => {
  it("renders Cloudflare DNS-01 with TRAEFIK_* flags + provider token in one env block", () => {
    const out = renderTraefikOverride({
      mode: "dns-01",
      domain: "agenthub.example.com",
      tlsEmail: "ops@example.com",
      dnsProvider: "cloudflare",
      dnsEnvVars: { CF_DNS_API_TOKEN: "${CF_DNS_API_TOKEN}" },
    });
    const parsed = parseYaml(out!) as Record<string, unknown>;
    const traefik = (parsed["services"] as Record<string, {
      command?: string[];
      environment: Record<string, string>;
    }>)["traefik"];
    expect(traefik).toBeDefined();
    expect(traefik!.command).toBeUndefined();
    expect(traefik!.environment).toMatchObject({
      TRAEFIK_CERTIFICATESRESOLVERS_LE_ACME_DNSCHALLENGE: "true",
      TRAEFIK_CERTIFICATESRESOLVERS_LE_ACME_DNSCHALLENGE_PROVIDER: "cloudflare",
      TRAEFIK_CERTIFICATESRESOLVERS_LE_ACME_EMAIL: "ops@example.com",
      TRAEFIK_CERTIFICATESRESOLVERS_LE_ACME_STORAGE: "/letsencrypt/acme.json",
      CF_DNS_API_TOKEN: "${CF_DNS_API_TOKEN}",
    });
  });

  it("renders Route53 DNS-01 with all three lego env vars passed through", () => {
    const out = renderTraefikOverride({
      mode: "dns-01",
      domain: "agenthub.example.com",
      tlsEmail: "ops@example.com",
      dnsProvider: "route53",
      dnsEnvVars: {
        AWS_ACCESS_KEY_ID: "${AWS_ACCESS_KEY_ID}",
        AWS_SECRET_ACCESS_KEY: "${AWS_SECRET_ACCESS_KEY}",
        AWS_REGION: "${AWS_REGION}",
      },
    });
    const parsed = parseYaml(out!) as Record<string, unknown>;
    const traefik = (parsed["services"] as Record<string, {
      environment: Record<string, string>;
    }>)["traefik"];
    expect(traefik).toBeDefined();
    expect(Object.keys(traefik!.environment)).toEqual(
      expect.arrayContaining([
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_REGION",
        "TRAEFIK_CERTIFICATESRESOLVERS_LE_ACME_DNSCHALLENGE_PROVIDER",
      ]),
    );
  });

  it("throws when dns-01 has no provider", () => {
    expect(() =>
      renderTraefikOverride({
        mode: "dns-01",
        domain: "agenthub.example.com",
        tlsEmail: "ops@example.com",
        dnsProvider: "",
        dnsEnvVars: {},
      }),
    ).toThrow(/dnsProvider/);
  });
});

describe("renderTraefikOverride self-ca", () => {
  it("renders init container + renew sidecar + static nginx", () => {
    const out = renderTraefikOverride({
      mode: "self-ca",
      domain: "agenthub.physhlab.com",
      tlsEmail: "",
      lanIp: "192.168.4.36",
    });
    const parsed = parseYaml(out!) as Record<string, unknown>;
    const services = parsed["services"] as Record<string, unknown>;
    expect(services).toHaveProperty("traefik-self-ca-init");
    expect(services).toHaveProperty("traefik-self-ca-renew");
    expect(services).toHaveProperty("agenthub-static");
    const traefik = services["traefik"] as {
      command?: string[];
      environment: Record<string, string>;
    };
    expect(traefik.command).toBeUndefined();
    expect(traefik.environment).toMatchObject({
      TRAEFIK_PROVIDERS_FILE_DIRECTORY: "/etc/traefik/dynamic",
    });
  });

  it("init container receives DOMAIN + LAN_IP env", () => {
    const out = renderTraefikOverride({
      mode: "self-ca",
      domain: "agenthub.physhlab.com",
      tlsEmail: "",
      lanIp: "192.168.4.36,10.0.0.1",
    });
    const parsed = parseYaml(out!) as Record<string, unknown>;
    const init = (parsed["services"] as Record<string, {
      environment: Record<string, string>;
    }>)["traefik-self-ca-init"];
    expect(init).toBeDefined();
    expect(init!.environment["DOMAIN"]).toBe("agenthub.physhlab.com");
    expect(init!.environment["LAN_IP"]).toBe("192.168.4.36,10.0.0.1");
  });

  it("nginx sidecar exposes /.well-known/agenthub-ca.crt and /install/ca on web entrypoint", () => {
    const out = renderTraefikOverride({
      mode: "self-ca",
      domain: "agenthub.physhlab.com",
      tlsEmail: "",
      lanIp: "192.168.4.36",
    });
    const parsed = parseYaml(out!) as Record<string, unknown>;
    const nginx = (parsed["services"] as Record<string, { labels?: string[] }>)[
      "agenthub-static"
    ];
    const labels = nginx?.labels ?? [];
    expect(labels.some((l) => l.includes("agenthub-ca"))).toBe(true);
    expect(labels.some((l) => l.includes("install-ca"))).toBe(true);
  });

  it("throws when self-ca has no lanIp", () => {
    expect(() =>
      renderTraefikOverride({
        mode: "self-ca",
        domain: "x.com",
        tlsEmail: "",
        lanIp: "",
      }),
    ).toThrow(/lanIp/);
  });
});
