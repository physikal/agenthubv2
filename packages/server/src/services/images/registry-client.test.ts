import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerHubClient } from "./registry-client.js";

describe("DockerHubClient.listTags", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("paginates and returns flat tag names", async () => {
    const pages = [
      { results: [{ name: "v3.6" }, { name: "v3.7" }], next: "page2" },
      { results: [{ name: "v3.7.1" }, { name: "v3.7.2" }], next: null },
    ];
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      const body = pages[call++];
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    const client = new DockerHubClient();
    const tags = await client.listTags("traefik", 5);
    expect(tags).toEqual(["v3.6", "v3.7", "v3.7.1", "v3.7.2"]);
  });

  it("stops at maxPages even if next cursor is non-null", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ name: "x" }], next: "more" }), { status: 200 }),
    ) as typeof fetch;
    const client = new DockerHubClient();
    const tags = await client.listTags("traefik", 2);
    expect(tags).toHaveLength(2);
  });

  it("throws on 5xx", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 503 })) as typeof fetch;
    const client = new DockerHubClient();
    await expect(client.listTags("traefik", 1)).rejects.toThrow(/503/);
  });

  it("namespaces single-segment repos under library/ for the v2 API", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ results: [], next: null }), { status: 200 });
    }) as typeof fetch;
    const client = new DockerHubClient();
    await client.listTags("traefik", 1);
    await client.listTags("infisical/infisical", 1);
    expect(urls[0]).toContain("/repositories/library/traefik/tags");
    expect(urls[1]).toContain("/repositories/infisical/infisical/tags");
  });
});

describe("DockerHubClient.getDigest", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("returns Docker-Content-Digest header value", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://auth.docker.io/token")) {
        return new Response(JSON.stringify({ token: "abc" }), { status: 200 });
      }
      return new Response("", {
        status: 200,
        headers: { "Docker-Content-Digest": "sha256:cafef00d" },
      });
    }) as typeof fetch;

    const client = new DockerHubClient();
    const digest = await client.getDigest("infisical/infisical", "latest-postgres");
    expect(digest).toBe("sha256:cafef00d");
  });

  it("throws when manifest endpoint returns 4xx", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://auth.docker.io/token")) {
        return new Response(JSON.stringify({ token: "abc" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const client = new DockerHubClient();
    await expect(client.getDigest("foo/bar", "nonexistent")).rejects.toThrow(/404/);
  });
});
