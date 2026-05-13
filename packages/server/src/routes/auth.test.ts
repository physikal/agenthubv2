import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cookieSecureFromPublicUrl } from "./auth-cookie.js";

describe("cookieSecureFromPublicUrl", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns false when NODE_ENV is not production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AGENTHUB_PUBLIC_URL", "https://agenthub.example.com");
    expect(cookieSecureFromPublicUrl()).toBe(false);
  });

  it("returns false when PUBLIC_URL is http (lan mode)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AGENTHUB_PUBLIC_URL", "http://agenthub.local");
    expect(cookieSecureFromPublicUrl()).toBe(false);
  });

  it("returns true when prod + https PUBLIC_URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AGENTHUB_PUBLIC_URL", "https://agenthub.example.com");
    expect(cookieSecureFromPublicUrl()).toBe(true);
  });

  it("returns false when PUBLIC_URL is missing (defensive)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AGENTHUB_PUBLIC_URL", "");
    expect(cookieSecureFromPublicUrl()).toBe(false);
  });
});
