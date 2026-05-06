import { describe, it, expect } from "vitest";
import { resolveTlsMode } from "./resolve-mode.js";

describe("resolveTlsMode", () => {
  it("returns 'none' for localhost domain in auto mode", () => {
    expect(resolveTlsMode("auto", "localhost", {})).toBe("none");
  });

  it("returns 'dns-01' when AGENTHUB_TLS_DNS_PROVIDER is set", () => {
    expect(
      resolveTlsMode("auto", "foo.com", {
        AGENTHUB_TLS_DNS_PROVIDER: "cloudflare",
      }),
    ).toBe("dns-01");
  });

  it("returns 'public-alpn' for real domain with no DNS provider", () => {
    expect(resolveTlsMode("auto", "foo.com", {})).toBe("public-alpn");
  });

  it("respects explicit non-auto mode regardless of env", () => {
    expect(
      resolveTlsMode("self-ca", "foo.com", {
        AGENTHUB_TLS_DNS_PROVIDER: "cloudflare",
      }),
    ).toBe("self-ca");
  });

  it("returns 'none' for explicit public-alpn on localhost (degenerate)", () => {
    expect(resolveTlsMode("public-alpn", "localhost", {})).toBe("none");
  });
});
