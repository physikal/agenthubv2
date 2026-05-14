import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveAgenthubHost } from "./public-host.js";

const KEYS = ["AGENTHUB_PUBLIC_HOST", "AGENTHUB_PUBLIC_URL"] as const;

describe("resolveAgenthubHost", () => {
  const original: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      original[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it("prefers AGENTHUB_PUBLIC_HOST when set", () => {
    process.env["AGENTHUB_PUBLIC_HOST"] = "vm.local";
    process.env["AGENTHUB_PUBLIC_URL"] = "http://other.example/";
    expect(resolveAgenthubHost()).toBe("vm.local");
  });

  it("derives from AGENTHUB_PUBLIC_URL hostname when host is unset", () => {
    process.env["AGENTHUB_PUBLIC_URL"] = "http://agenthub.example.com/api";
    expect(resolveAgenthubHost()).toBe("agenthub.example.com");
  });

  it("strips port from PUBLIC_URL host derivation", () => {
    process.env["AGENTHUB_PUBLIC_URL"] = "http://192.168.4.83:8080/";
    expect(resolveAgenthubHost()).toBe("192.168.4.83");
  });

  it("falls back to 127.0.0.1 when neither is set", () => {
    expect(resolveAgenthubHost()).toBe("127.0.0.1");
  });

  it("respects custom fallback", () => {
    expect(resolveAgenthubHost("<unknown>")).toBe("<unknown>");
  });

  it("falls through on malformed AGENTHUB_PUBLIC_URL", () => {
    process.env["AGENTHUB_PUBLIC_URL"] = "not-a-url";
    expect(resolveAgenthubHost("custom-fallback")).toBe("custom-fallback");
  });

  it("handles https:// URLs identically to http://", () => {
    process.env["AGENTHUB_PUBLIC_URL"] = "https://agenthub.example.com/";
    expect(resolveAgenthubHost()).toBe("agenthub.example.com");
  });
});
