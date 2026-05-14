import { describe, it, expect } from "vitest";
import { explainAcmeFailure } from "./headless.js";

describe("explainAcmeFailure", () => {
  it("returns dns-01 hints", () => {
    const msg = explainAcmeFailure("dns-01");
    expect(msg).toMatch(/wrong API token|zone|propagation/i);
  });

  it("returns public-alpn hints", () => {
    const msg = explainAcmeFailure("public-alpn");
    expect(msg).toMatch(/port 443|DNS A record|ISP/i);
  });

  it("returns public access mode hints", () => {
    expect(explainAcmeFailure("public")).toMatch(/port 443|DNS A record|ACME/i);
  });

  it("returns generic hint for unknown mode", () => {
    expect(explainAcmeFailure("unknown" as never)).toMatch(/unexpected/i);
  });
});
