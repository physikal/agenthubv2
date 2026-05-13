import { describe, it, expect } from "vitest";
import { resolveAccessMode, resolvePublicTlsMode } from "./resolve-mode.js";

describe("resolveAccessMode", () => {
  it("defaults to 'lan' when nothing is declared", () => {
    expect(resolveAccessMode("lan", "192.168.1.5", {})).toBe("lan");
  });

  it("returns 'lan' for localhost regardless of declared mode", () => {
    expect(resolveAccessMode("public", "localhost", {})).toBe("lan");
  });

  it("honors explicit 'public' for real domains", () => {
    expect(resolveAccessMode("public", "agenthub.example.com", {})).toBe("public");
  });

  it("honors explicit 'lan' for real domains (user opted out of TLS)", () => {
    expect(resolveAccessMode("lan", "agenthub.example.com", {})).toBe("lan");
  });
});

describe("resolvePublicTlsMode", () => {
  it("returns 'dns-01' when AGENTHUB_TLS_DNS_PROVIDER is set", () => {
    expect(resolvePublicTlsMode("auto", { AGENTHUB_TLS_DNS_PROVIDER: "cloudflare" }))
      .toBe("dns-01");
  });

  it("returns 'public-alpn' by default in auto", () => {
    expect(resolvePublicTlsMode("auto", {})).toBe("public-alpn");
  });

  it("honors explicit public-alpn", () => {
    expect(resolvePublicTlsMode("public-alpn", { AGENTHUB_TLS_DNS_PROVIDER: "cloudflare" }))
      .toBe("public-alpn");
  });

  it("honors explicit dns-01", () => {
    expect(resolvePublicTlsMode("dns-01", {})).toBe("dns-01");
  });
});
