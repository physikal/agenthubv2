import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { preflightCloudflare, preflightDns01 } from "./preflight.js";

describe("preflightCloudflare", () => {
  let fetchSpy!: ReturnType<typeof vi.spyOn> & {
    mockResolvedValue: (v: Response) => void;
    mockImplementation: (fn: () => Promise<Response>) => void;
    mockRestore: () => void;
  };

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch") as never;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns ok when token + zone match", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: [{ id: "abc", name: "example.com" }],
        }),
        { status: 200 },
      ),
    );
    const r = await preflightCloudflare("test-token", "agenthub.example.com");
    expect(r.ok).toBe(true);
  });

  it("returns failure when API rejects the token", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ message: "Invalid API Token" }],
        }),
        { status: 403 },
      ),
    );
    const r = await preflightCloudflare("bad-token", "agenthub.example.com");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Invalid API Token/i);
  });

  it("returns failure when zone doesn't match", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
        }),
      ),
    );
    const r = await preflightCloudflare("ok-token", "agenthub.example.com");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no Cloudflare zone matching/i);
  });
});

describe("preflightDns01 (dispatch)", () => {
  let fetchSpy!: ReturnType<typeof vi.spyOn> & {
    mockResolvedValue: (v: Response) => void;
    mockImplementation: (fn: () => Promise<Response>) => void;
    mockRestore: () => void;
  };

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch") as never;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("calls Cloudflare path", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ success: true, result: [{ name: "x.com" }] }),
        { status: 200 },
      ),
    );
    const r = await preflightDns01("cloudflare", "x.com", { CF_DNS_API_TOKEN: "t" });
    expect(r.ok).toBe(true);
  });

  it("skips for non-Cloudflare providers (no API check available)", async () => {
    const r = await preflightDns01("route53", "x.com", {});
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
  });
});
