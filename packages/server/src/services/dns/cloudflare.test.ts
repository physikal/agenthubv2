import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCloudflareDns,
  deleteCloudflareDns,
  domainCoveredByZone,
  lookupZoneName,
  upsertCloudflareDns,
} from "./cloudflare.js";

type FetchMock = ReturnType<typeof vi.fn>;

function mockFetchSequence(...responses: Array<Response | Error>): FetchMock {
  const mock = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) mock.mockRejectedValueOnce(r);
    else mock.mockResolvedValueOnce(r);
  }
  vi.stubGlobal("fetch", mock);
  return mock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {});
afterEach(() => vi.unstubAllGlobals());

describe("lookupZoneName", () => {
  it("returns the zone name for a valid zoneId", async () => {
    mockFetchSequence(jsonResponse({ result: { id: "z1", name: "example.com" } }));
    await expect(lookupZoneName("tok", "z1")).resolves.toBe("example.com");
  });

  it("throws DeployError(502) on non-2xx", async () => {
    mockFetchSequence(jsonResponse({ errors: [{ message: "Invalid token" }] }, 401));
    await expect(lookupZoneName("tok", "z1")).rejects.toMatchObject({
      status: 502,
    });
  });

  it("throws DeployError(400) when response body lacks a name", async () => {
    mockFetchSequence(jsonResponse({ result: {} }));
    await expect(lookupZoneName("tok", "z1")).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("upsertCloudflareDns", () => {
  it("POSTs a new record when none exists", async () => {
    const mock = mockFetchSequence(
      jsonResponse({ result: [] }),
      jsonResponse({ result: { id: "r1" } }),
    );
    await expect(
      upsertCloudflareDns("tok", "z1", "hello.example.com", "1.2.3.4"),
    ).resolves.toBe("created");
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[1]![1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        type: "A",
        name: "hello.example.com",
        content: "1.2.3.4",
        proxied: false,
        ttl: 300,
      }),
    });
  });

  it("no-ops when the existing record already matches", async () => {
    const mock = mockFetchSequence(
      jsonResponse({
        result: [
          { id: "r1", name: "hello.example.com", type: "A", content: "1.2.3.4" },
        ],
      }),
    );
    await expect(
      upsertCloudflareDns("tok", "z1", "hello.example.com", "1.2.3.4"),
    ).resolves.toBe("unchanged");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("PATCHes the existing record when the IP has moved", async () => {
    const mock = mockFetchSequence(
      jsonResponse({
        result: [
          { id: "r1", name: "hello.example.com", type: "A", content: "1.2.3.4" },
        ],
      }),
      jsonResponse({ result: { id: "r1" } }),
    );
    await expect(
      upsertCloudflareDns("tok", "z1", "hello.example.com", "9.9.9.9"),
    ).resolves.toBe("updated");
    expect(mock.mock.calls[1]![0]).toMatch(/\/dns_records\/r1$/);
    expect(mock.mock.calls[1]![1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ content: "9.9.9.9" }),
    });
  });

  it("bubbles up CF errors from the list step", async () => {
    mockFetchSequence(jsonResponse({ errors: [{ message: "nope" }] }, 401));
    await expect(
      upsertCloudflareDns("tok", "z1", "hello.example.com", "1.2.3.4"),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("bubbles up CF errors from the create step", async () => {
    mockFetchSequence(
      jsonResponse({ result: [] }),
      jsonResponse({ errors: [{ message: "conflict" }] }, 400),
    );
    await expect(
      upsertCloudflareDns("tok", "z1", "hello.example.com", "1.2.3.4"),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("ignores non-A records sharing the name", async () => {
    mockFetchSequence(
      jsonResponse({
        result: [
          { id: "r-aaaa", name: "hello.example.com", type: "AAAA", content: "::1" },
        ],
      }),
      jsonResponse({ result: { id: "r-a" } }),
    );
    await expect(
      upsertCloudflareDns("tok", "z1", "hello.example.com", "1.2.3.4"),
    ).resolves.toBe("created");
  });
});

describe("createCloudflareDns (legacy path)", () => {
  it("POSTs and succeeds on 2xx", async () => {
    mockFetchSequence(jsonResponse({ result: { id: "r1" } }));
    await expect(
      createCloudflareDns("tok", "z1", "hello.example.com", "1.2.3.4"),
    ).resolves.toBeUndefined();
  });

  it("throws on non-2xx", async () => {
    mockFetchSequence(jsonResponse({ errors: [{ message: "exists" }] }, 400));
    await expect(
      createCloudflareDns("tok", "z1", "hello.example.com", "1.2.3.4"),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe("deleteCloudflareDns", () => {
  it("deletes every matching record", async () => {
    const mock = mockFetchSequence(
      jsonResponse({
        result: [
          { id: "r1", name: "hello.example.com", type: "A", content: "1.2.3.4" },
          { id: "r2", name: "hello.example.com", type: "A", content: "5.6.7.8" },
        ],
      }),
      jsonResponse({ result: null }),
      jsonResponse({ result: null }),
    );
    await deleteCloudflareDns("tok", "z1", "hello.example.com");
    expect(mock).toHaveBeenCalledTimes(3);
    expect(mock.mock.calls[1]![1]).toMatchObject({ method: "DELETE" });
    expect(mock.mock.calls[2]![1]).toMatchObject({ method: "DELETE" });
  });

  it("returns silently when list fails", async () => {
    mockFetchSequence(jsonResponse({}, 500));
    await expect(
      deleteCloudflareDns("tok", "z1", "hello.example.com"),
    ).resolves.toBeUndefined();
  });

  it("returns silently when no matching record", async () => {
    mockFetchSequence(jsonResponse({ result: [] }));
    await expect(
      deleteCloudflareDns("tok", "z1", "hello.example.com"),
    ).resolves.toBeUndefined();
  });
});

describe("domainCoveredByZone", () => {
  it("matches the zone itself", () => {
    expect(domainCoveredByZone("example.com", "example.com")).toBe(true);
  });

  it("matches subdomains", () => {
    expect(domainCoveredByZone("foo.example.com", "example.com")).toBe(true);
    expect(domainCoveredByZone("a.b.example.com", "example.com")).toBe(true);
  });

  it("rejects unrelated domains", () => {
    expect(domainCoveredByZone("other.com", "example.com")).toBe(false);
    expect(domainCoveredByZone("evil-example.com", "example.com")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(domainCoveredByZone("Foo.Example.COM", "example.com")).toBe(true);
  });
});
