import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DokployHostingProvider } from "./dokploy-hosting.js";

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

const CONFIG = {
  baseUrl: "https://dokploy.example.com",
  apiToken: "tok",
  projectId: "p-123",
  environmentId: "e-456",
} as const;

describe("DokployHostingProvider.verify", () => {
  let provider: DokployHostingProvider;

  beforeEach(() => {
    provider = new DokployHostingProvider();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ok when token + env + project all match", async () => {
    const fetchMock = mockFetchSequence(
      jsonResponse([{ projectId: "p-123" }]),
      jsonResponse({ environmentId: "e-456", project: { projectId: "p-123" } }),
    );
    const result = await provider.verify(CONFIG);
    expect(result).toEqual({ ok: true, issues: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://dokploy.example.com/api/project.all");
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "https://dokploy.example.com/api/environment.one?environmentId=e-456",
    );
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ headers: { "x-api-key": "tok" } });
  });

  it("accepts the tRPC envelope shape { result: { data: ... } }", async () => {
    mockFetchSequence(
      jsonResponse([]),
      jsonResponse({
        result: { data: { environmentId: "e-456", project: { projectId: "p-123" } } },
      }),
    );
    const result = await provider.verify(CONFIG);
    expect(result.ok).toBe(true);
  });

  it("reports a bad token on 401 from project.all", async () => {
    mockFetchSequence(jsonResponse({ message: "Unauthorized" }, 401));
    const result = await provider.verify(CONFIG);
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatch(/token rejected/i);
  });

  it("reports unreachable URL on non-OK non-401 from project.all", async () => {
    mockFetchSequence(jsonResponse("bad gateway", 502));
    const result = await provider.verify(CONFIG);
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatch(/check baseUrl/);
  });

  it("reports missing env on 500 (tRPC wraps not-found)", async () => {
    mockFetchSequence(jsonResponse([]), jsonResponse({ code: "INTERNAL" }, 500));
    const result = await provider.verify(CONFIG);
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatch(/environmentId "e-456" not found/);
  });

  it("reports wrong-org on 403 from environment.one", async () => {
    mockFetchSequence(jsonResponse([]), jsonResponse({}, 403));
    const result = await provider.verify(CONFIG);
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatch(/different Dokploy organization/);
  });

  it("reports projectId mismatch when env belongs to a different project", async () => {
    mockFetchSequence(
      jsonResponse([]),
      jsonResponse({ environmentId: "e-456", project: { projectId: "p-OTHER" } }),
    );
    const result = await provider.verify(CONFIG);
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatch(/belongs to project "p-OTHER"/);
  });

  it("bubbles up a reachability failure", async () => {
    mockFetchSequence(new TypeError("ECONNREFUSED"));
    const result = await provider.verify(CONFIG);
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatch(/Dokploy API unreachable/);
  });

  it("short-circuits when validate() already finds config problems", async () => {
    const result = await provider.verify({
      baseUrl: "https://dokploy.example.com",
      apiToken: "",
      projectId: "p-1",
      environmentId: "e-1",
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatch(/apiToken is required/);
  });
});
