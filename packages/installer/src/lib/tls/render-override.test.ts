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
