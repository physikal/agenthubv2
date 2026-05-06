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

  it("renders public-alpn with the canonical Traefik flags", () => {
    const out = renderTraefikOverride({
      mode: "public-alpn",
      domain: "agenthub.example.com",
      tlsEmail: "ops@example.com",
    });
    expect(out).not.toBeNull();
    const parsed = parseYaml(out!) as Record<string, unknown>;
    const traefik = (parsed["services"] as Record<string, { command: string[] }>)[
      "traefik"
    ];
    expect(traefik).toBeDefined();
    expect(traefik!.command).toEqual(
      expect.arrayContaining([
        "--certificatesresolvers.le.acme.tlschallenge=true",
        "--certificatesresolvers.le.acme.email=ops@example.com",
        "--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json",
      ]),
    );
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
  it("renders Cloudflare DNS-01 with token mapped to CF_DNS_API_TOKEN", () => {
    const out = renderTraefikOverride({
      mode: "dns-01",
      domain: "agenthub.example.com",
      tlsEmail: "ops@example.com",
      dnsProvider: "cloudflare",
      dnsEnvVars: { CF_DNS_API_TOKEN: "${CF_DNS_API_TOKEN}" },
    });
    const parsed = parseYaml(out!) as Record<string, unknown>;
    const traefik = (parsed["services"] as Record<string, {
      command: string[];
      environment: Record<string, string>;
    }>)["traefik"];
    expect(traefik).toBeDefined();
    expect(traefik!.command).toEqual(
      expect.arrayContaining([
        "--certificatesresolvers.le.acme.dnschallenge=true",
        "--certificatesresolvers.le.acme.dnschallenge.provider=cloudflare",
        "--certificatesresolvers.le.acme.email=ops@example.com",
      ]),
    );
    expect(traefik!.environment).toEqual({
      CF_DNS_API_TOKEN: "${CF_DNS_API_TOKEN}",
    });
  });

  it("renders Route53 DNS-01 with all three env vars passed through", () => {
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
