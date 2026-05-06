import { describe, it, expect } from "vitest";
import { parseOpensslOutput } from "./probe-cert.js";

const TRAEFIK_DEFAULT_OUTPUT = `
CONNECTED(00000003)
depth=0 CN=TRAEFIK DEFAULT CERT
verify return:1
---
Server certificate
subject=CN=TRAEFIK DEFAULT CERT
issuer=CN=TRAEFIK DEFAULT CERT
notBefore=Apr 25 00:43:25 2026 GMT
notAfter=Apr 25 00:43:25 2027 GMT
---
`;

const LE_OUTPUT = `
CONNECTED(00000003)
---
Server certificate
subject=CN=agenthub.example.com
issuer=C=US, O=Let's Encrypt, CN=R10
notBefore=Mar 1 12:00:00 2026 GMT
notAfter=May 30 12:00:00 2026 GMT
---
`;

describe("parseOpensslOutput", () => {
  it("identifies TRAEFIK DEFAULT CERT", () => {
    const out = parseOpensslOutput(TRAEFIK_DEFAULT_OUTPUT);
    expect(out.issuerCN).toBe("TRAEFIK DEFAULT CERT");
    expect(out.subjectCN).toBe("TRAEFIK DEFAULT CERT");
    expect(out.isTraefikDefault).toBe(true);
  });

  it("parses Let's Encrypt cert", () => {
    const out = parseOpensslOutput(LE_OUTPUT);
    expect(out.issuerCN).toBe("R10");
    expect(out.issuerO).toBe("Let's Encrypt");
    expect(out.subjectCN).toBe("agenthub.example.com");
    expect(out.isTraefikDefault).toBe(false);
    expect(out.notAfter.toISOString()).toBe("2026-05-30T12:00:00.000Z");
  });

  it("handles missing fields gracefully", () => {
    expect(() => parseOpensslOutput("")).toThrow(/no subject/);
  });
});
