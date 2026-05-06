import { describe, it, expect } from "vitest";
import { classifyCert, type ParsedTlsCert } from "./health.js";

const now = new Date("2026-05-05T00:00:00Z");

const traefikDefault: ParsedTlsCert = {
  subjectCN: "TRAEFIK DEFAULT CERT",
  issuerCN: "TRAEFIK DEFAULT CERT",
  notBefore: new Date("2026-04-25"),
  notAfter: new Date("2027-04-25"),
};
const validLE: ParsedTlsCert = {
  subjectCN: "agenthub.physhlab.com",
  issuerCN: "R10",
  issuerO: "Let's Encrypt",
  notBefore: new Date("2026-03-01"),
  notAfter: new Date("2026-06-01"),
};
const expiringSoon: ParsedTlsCert = {
  ...validLE,
  notAfter: new Date("2026-05-15"),
};
const expired: ParsedTlsCert = {
  ...validLE,
  notAfter: new Date("2026-04-01"),
};
const selfCa: ParsedTlsCert = {
  subjectCN: "agenthub.local",
  issuerCN: "AgentHub Self-CA (agenthub.local)",
  notBefore: new Date("2026-04-01"),
  notAfter: new Date("2028-08-01"),
};

describe("classifyCert", () => {
  it("flags TRAEFIK DEFAULT CERT as default-fallback", () => {
    const r = classifyCert(traefikDefault, "agenthub.physhlab.com", now);
    expect(r.resolver).toBe("default-fallback");
    expect(r.ok).toBe(false);
    expect(r.warnings).toContain(
      "serving Traefik default cert — TLS misconfigured",
    );
  });

  it("identifies Let's Encrypt by issuer", () => {
    const r = classifyCert(validLE, "agenthub.physhlab.com", now);
    expect(r.resolver).toBe("public-alpn");
    expect(r.issuer).toBe("Let's Encrypt");
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.daysToExpiry).toBe(27);
  });

  it("identifies self-CA by issuer prefix", () => {
    const r = classifyCert(selfCa, "agenthub.local", now);
    expect(r.resolver).toBe("self-ca");
    expect(r.issuer).toMatch(/AgentHub Self-CA/);
    expect(r.ok).toBe(true);
  });

  it("warns when expiring < 14 days", () => {
    const r = classifyCert(expiringSoon, "agenthub.physhlab.com", now);
    expect(r.ok).toBe(true);
    expect(r.warnings).toContain("expires in 10 days");
  });

  it("flags expired cert", () => {
    const r = classifyCert(expired, "agenthub.physhlab.com", now);
    expect(r.ok).toBe(false);
    expect(r.warnings.some((w) => /expired/i.test(w))).toBe(true);
  });
});
