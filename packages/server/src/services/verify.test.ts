import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  verifyAnthropicKey,
  verifyOpenAIKey,
  verifyMinimaxKey,
  verifyCloudflare,
  verifyB2,
  verifyNonHostingCredentials,
} from "./verify.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  // @ts-expect-error -- mock fetch
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => responder(url, init));
}

describe("verifyAnthropicKey", () => {
  it("returns ok on 200", async () => {
    mockFetch(() => new Response("{}", { status: 200 }));
    const r = await verifyAnthropicKey("sk-test");
    expect(r.ok).toBe(true);
  });

  it("treats 429 as authenticated", async () => {
    mockFetch(() => new Response("rate limited", { status: 429 }));
    const r = await verifyAnthropicKey("sk-test");
    expect(r.ok).toBe(true);
  });

  it("returns not ok on 401", async () => {
    mockFetch(() => new Response("unauthorized", { status: 401 }));
    const r = await verifyAnthropicKey("sk-bad");
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/rejected/);
  });

  it("hits /v1/models (GET, no body)", async () => {
    let seenUrl = "";
    let seenMethod = "";
    mockFetch((url, init) => {
      seenUrl = url;
      seenMethod = (init?.method ?? "GET").toUpperCase();
      return new Response("{}", { status: 200 });
    });
    await verifyAnthropicKey("sk-test");
    expect(seenUrl).toBe("https://api.anthropic.com/v1/models");
    expect(seenMethod).toBe("GET");
  });

  it("hits custom baseUrl when provided", async () => {
    let seenUrl = "";
    mockFetch((url) => {
      seenUrl = url;
      return new Response("{}", { status: 200 });
    });
    await verifyAnthropicKey("sk-test", "https://proxy.example/anthropic");
    expect(seenUrl).toBe("https://proxy.example/anthropic/v1/models");
  });

  it("strips trailing slash from baseUrl", async () => {
    let seenUrl = "";
    mockFetch((url) => {
      seenUrl = url;
      return new Response("{}", { status: 200 });
    });
    await verifyAnthropicKey("sk-test", "https://proxy.example/anthropic/");
    expect(seenUrl).toBe("https://proxy.example/anthropic/v1/models");
  });

  it("returns not ok when fetch throws", async () => {
    mockFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const r = await verifyAnthropicKey("sk-test");
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/unreachable|ECONNREFUSED/);
  });
});

describe("verifyOpenAIKey", () => {
  it("returns ok on 200", async () => {
    mockFetch(() => new Response("{}", { status: 200 }));
    const r = await verifyOpenAIKey("sk-test");
    expect(r.ok).toBe(true);
  });

  it("returns not ok on 401", async () => {
    mockFetch(() => new Response("unauthorized", { status: 401 }));
    const r = await verifyOpenAIKey("sk-bad");
    expect(r.ok).toBe(false);
  });

  it("uses GET, not POST", async () => {
    let method = "";
    mockFetch((_url, init) => {
      method = (init?.method ?? "GET").toUpperCase();
      return new Response("{}", { status: 200 });
    });
    await verifyOpenAIKey("sk-test");
    expect(method).toBe("GET");
  });
});

describe("verifyMinimaxKey", () => {
  it("hits /anthropic/v1/messages by default", async () => {
    let seenUrl = "";
    mockFetch((url) => {
      seenUrl = url;
      return new Response("{}", { status: 200 });
    });
    await verifyMinimaxKey("test");
    expect(seenUrl).toBe("https://api.minimax.io/anthropic/v1/messages");
  });
});

describe("verifyCloudflare", () => {
  it("returns ok on 200", async () => {
    mockFetch(() => new Response("{}", { status: 200 }));
    const r = await verifyCloudflare("token", "zone");
    expect(r.ok).toBe(true);
  });

  it("returns specific issue for 404 zone", async () => {
    mockFetch(() => new Response("not found", { status: 404 }));
    const r = await verifyCloudflare("token", "zone-x");
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/zone-x.*not found/);
  });

  it("returns specific issue for 403 token", async () => {
    mockFetch(() => new Response("forbidden", { status: 403 }));
    const r = await verifyCloudflare("token", "zone");
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/rejected/);
  });
});

describe("verifyB2", () => {
  it("returns ok when key is unscoped (no bucket restriction)", async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ apiInfo: { storageApi: { bucketName: null } } }), {
        status: 200,
      }),
    );
    const r = await verifyB2("keyId", "appKey", "my-bucket");
    expect(r.ok).toBe(true);
  });

  it("returns ok when scoped to matching bucket", async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({ apiInfo: { storageApi: { bucketName: "my-bucket" } } }),
        { status: 200 },
      ),
    );
    const r = await verifyB2("keyId", "appKey", "my-bucket");
    expect(r.ok).toBe(true);
  });

  it("returns not ok when key is scoped to a different bucket", async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({ apiInfo: { storageApi: { bucketName: "other" } } }),
        { status: 200 },
      ),
    );
    const r = await verifyB2("keyId", "appKey", "my-bucket");
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/scoped.*other.*my-bucket/);
  });

  it("returns not ok on 401", async () => {
    mockFetch(() => new Response("unauthorized", { status: 401 }));
    const r = await verifyB2("keyId", "wrongKey", "my-bucket");
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/rejected/);
  });
});

describe("verifyNonHostingCredentials dispatcher", () => {
  beforeEach(() => {
    mockFetch(() => new Response("{}", { status: 200 }));
  });

  it("dispatches cloudflare", async () => {
    const r = await verifyNonHostingCredentials("cloudflare", {
      apiToken: "t",
      zoneId: "z",
    });
    expect(r).not.toBeNull();
    expect(r?.ok).toBe(true);
  });

  it("dispatches ai-anthropic", async () => {
    const r = await verifyNonHostingCredentials("ai-anthropic", { apiKey: "k" });
    expect(r).not.toBeNull();
    expect(r?.ok).toBe(true);
  });

  it("dispatches ai-openai", async () => {
    const r = await verifyNonHostingCredentials("ai-openai", { apiKey: "k" });
    expect(r).not.toBeNull();
    expect(r?.ok).toBe(true);
  });

  it("dispatches ai-minimax", async () => {
    const r = await verifyNonHostingCredentials("ai-minimax", { apiKey: "k" });
    expect(r).not.toBeNull();
    expect(r?.ok).toBe(true);
  });

  it("dispatches github", async () => {
    const r = await verifyNonHostingCredentials("github", { pat: "ghp_x" });
    expect(r).not.toBeNull();
    expect(r?.ok).toBe(true);
  });

  it("dispatches github with bad pat (401)", async () => {
    mockFetch(() => new Response("unauthorized", { status: 401 }));
    const r = await verifyNonHostingCredentials("github", { pat: "ghp_bad" });
    expect(r).not.toBeNull();
    expect(r?.ok).toBe(false);
    expect(r?.issues.join(" ")).toMatch(/rejected/);
  });

  it("dispatches b2", async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ apiInfo: { storageApi: { bucketName: null } } }), {
        status: 200,
      }),
    );
    const r = await verifyNonHostingCredentials("b2", {
      b2KeyId: "k",
      b2AppKey: "a",
      b2Bucket: "b",
    });
    expect(r).not.toBeNull();
    expect(r?.ok).toBe(true);
  });

  it("returns null for hosting providers (caller falls back to provider.verify)", async () => {
    const r = await verifyNonHostingCredentials("docker", {});
    expect(r).toBeNull();
  });

  it("returns null for unknown provider", async () => {
    const r = await verifyNonHostingCredentials("unknown-x", {});
    expect(r).toBeNull();
  });

  it("handles missing string config keys gracefully", async () => {
    // verifyCloudflare is invoked with empty strings — upstream returns 400 etc.
    // Just confirm we don't throw.
    mockFetch(() => new Response("bad request", { status: 400 }));
    const r = await verifyNonHostingCredentials("cloudflare", {});
    expect(r?.ok).toBe(false);
  });
});
