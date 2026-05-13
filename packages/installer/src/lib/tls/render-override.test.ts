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

  it("public-alpn: only adds the cert-resolver label on agenthub-server (no traefik command/env)", () => {
    const out = renderTraefikOverride({
      mode: "public-alpn",
      domain: "agenthub.example.com",
      tlsEmail: "ops@example.com",
    });
    expect(out).not.toBeNull();
    const parsed = parseYaml(out!) as Record<string, unknown>;
    const services = parsed["services"] as Record<string, {
      command?: string[];
      environment?: Record<string, string>;
      labels?: string[];
    }>;
    // Bug #1 regression guard: NEVER emit traefik.command (would clobber
    // the base via list-replace merge).
    expect(services["traefik"]).toBeUndefined();
    expect(services["agenthub-server"]?.labels).toEqual([
      "traefik.http.routers.agenthub.tls.certresolver=le",
    ]);
  });

  it("public-alpn: throws when tlsEmail is empty", () => {
    expect(() =>
      renderTraefikOverride({
        mode: "public-alpn",
        domain: "agenthub.example.com",
        tlsEmail: "",
      }),
    ).toThrow(/AGENTHUB_TLS_EMAIL/);
  });

  it("dns-01: adds DNS provider env vars to traefik service + cert-resolver label (no command, no TRAEFIK_*)", () => {
    const out = renderTraefikOverride({
      mode: "dns-01",
      domain: "agenthub.example.com",
      tlsEmail: "ops@example.com",
      dnsProvider: "cloudflare",
      dnsEnvVars: { CF_DNS_API_TOKEN: "${CF_DNS_API_TOKEN}" },
    });
    const parsed = parseYaml(out!) as Record<string, unknown>;
    const services = parsed["services"] as Record<string, {
      command?: string[];
      environment?: Record<string, string>;
      labels?: string[];
    }>;
    // Regression guard: no command, no TRAEFIK_* env vars (those go into
    // compose/traefik.yml via renderTraefikConfig now).
    expect(services["traefik"]?.command).toBeUndefined();
    expect(services["traefik"]?.environment).toEqual({
      CF_DNS_API_TOKEN: "${CF_DNS_API_TOKEN}",
    });
    // No TRAEFIK_*-prefixed keys leaking back in.
    for (const k of Object.keys(services["traefik"]?.environment ?? {})) {
      expect(k.startsWith("TRAEFIK_")).toBe(false);
    }
    expect(services["agenthub-server"]?.labels).toContain(
      "traefik.http.routers.agenthub.tls.certresolver=le",
    );
  });

  it("dns-01: throws when dnsProvider is missing", () => {
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

  it("self-ca: emits init/renew/static services + traefik volume mount (no command, no env)", () => {
    const out = renderTraefikOverride({
      mode: "self-ca",
      domain: "agenthub.example.com",
      tlsEmail: "",
      lanIp: "192.168.4.36",
    });
    const parsed = parseYaml(out!) as Record<string, unknown>;
    const services = parsed["services"] as Record<string, {
      command?: string[];
      environment?: Record<string, string>;
      volumes?: string[];
    }>;
    expect(services).toHaveProperty("traefik-self-ca-init");
    expect(services).toHaveProperty("traefik-self-ca-renew");
    expect(services).toHaveProperty("agenthub-static");
    // Traefik service: ONLY volumes + depends_on. No command, no env.
    expect(services["traefik"]?.command).toBeUndefined();
    expect(services["traefik"]?.environment).toBeUndefined();
    expect(services["traefik"]?.volumes).toEqual([
      "traefik-self-ca:/etc/traefik/dynamic:ro",
    ]);
  });

  it("self-ca: init container receives DOMAIN + LAN_IP env", () => {
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

  it("self-ca: nginx static service exposes /.well-known/agenthub-ca.crt and /install/ca on web entrypoint", () => {
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

  it("self-ca: throws when lanIp is empty", () => {
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
