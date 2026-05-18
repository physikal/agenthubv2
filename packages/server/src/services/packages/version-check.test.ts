import { afterEach, describe, expect, it, vi } from "vitest";
import { checkVersion } from "./version-check.js";

describe("checkVersion (npm)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("returns the version on a 200 with a version field", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: "1.2.3" }), { status: 200 }),
    ) as typeof fetch;
    const res = await checkVersion({ method: "npm", npmPackage: "@anthropic-ai/claude-code" });
    expect(res).toEqual({ latest: "1.2.3" });
  });

  it("returns an error string on non-200", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("not found", { status: 404 }),
    ) as typeof fetch;
    const res = await checkVersion({ method: "npm", npmPackage: "no-such-pkg" });
    expect("error" in res).toBe(true);
  });

  it("returns an error when the response has no version field", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    ) as typeof fetch;
    const res = await checkVersion({ method: "npm", npmPackage: "@anthropic-ai/claude-code" });
    expect("error" in res).toBe(true);
  });

  it("returns an error when fetch throws (network failure)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as typeof fetch;
    const res = await checkVersion({ method: "npm", npmPackage: "@anthropic-ai/claude-code" });
    expect("error" in res).toBe(true);
  });

  it("returns an error when the 200 body is not valid JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("<!DOCTYPE html>", { status: 200 }),
    ) as typeof fetch;
    const res = await checkVersion({ method: "npm", npmPackage: "@anthropic-ai/claude-code" });
    expect("error" in res).toBe(true);
  });

  it("URL-encodes scoped npm package names", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    await checkVersion({ method: "npm", npmPackage: "@openai/codex" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://registry.npmjs.org/%40openai%2Fcodex/latest",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe("checkVersion (other methods)", () => {
  it("returns an error for curl-sh", async () => {
    const res = await checkVersion({
      method: "curl-sh",
      scriptUrl: "https://app.factory.ai/cli",
    });
    expect("error" in res).toBe(true);
  });

  it("returns an error for binary", async () => {
    const res = await checkVersion({
      method: "binary",
      url: "https://example.com/bin.tar.gz",
    });
    expect("error" in res).toBe(true);
  });
});
