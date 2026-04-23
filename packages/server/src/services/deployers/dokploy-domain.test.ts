import { afterEach, describe, expect, it, vi } from "vitest";

import type { DokployConfig } from "./dokploy-api.js";
import {
  createDokployDomain,
  deleteDokployDomain,
  findDomainByHost,
  listDokployDomains,
} from "./dokploy-domain.js";

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

const CFG: DokployConfig = {
  baseUrl: "http://dokploy.example.com:3000",
  apiToken: "tok",
  projectId: "p1",
  environmentId: "e1",
};

afterEach(() => vi.unstubAllGlobals());

describe("createDokployDomain", () => {
  it("POSTs with the expected tRPC-openapi body shape", async () => {
    const mock = mockFetchSequence(
      jsonResponse({
        domainId: "d1",
        host: "hello.example.com",
        port: 80,
        path: "/",
        serviceName: "web",
        https: true,
        certificateType: "letsencrypt",
        composeId: "c1",
        applicationId: null,
      }),
    );
    const result = await createDokployDomain(CFG, {
      composeId: "c1",
      host: "hello.example.com",
      port: 80,
      serviceName: "web",
    });
    expect(result.domainId).toBe("d1");
    expect(mock.mock.calls[0]![0]).toBe(
      "http://dokploy.example.com:3000/api/domain.create",
    );
    const req = mock.mock.calls[0]![1] as RequestInit;
    expect(req.method).toBe("POST");
    expect(JSON.parse(req.body as string)).toEqual({
      composeId: "c1",
      host: "hello.example.com",
      port: 80,
      path: "/",
      serviceName: "web",
      https: true,
      certificateType: "letsencrypt",
      domainType: "compose",
    });
    expect((req.headers as Record<string, string>)["x-api-key"]).toBe("tok");
  });

  it("lets callers override path / https / certificateType", async () => {
    const mock = mockFetchSequence(jsonResponse({ domainId: "d1" }));
    await createDokployDomain(CFG, {
      composeId: "c1",
      host: "hello.example.com",
      port: 8080,
      serviceName: "api",
      path: "/api",
      https: false,
      certificateType: "none",
    });
    const body = JSON.parse((mock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.path).toBe("/api");
    expect(body.https).toBe(false);
    expect(body.certificateType).toBe("none");
  });

  it("throws DeployError(502) on upstream failure", async () => {
    mockFetchSequence(jsonResponse({ message: "conflict" }, 400));
    await expect(
      createDokployDomain(CFG, {
        composeId: "c1",
        host: "hello.example.com",
        port: 80,
        serviceName: "web",
      }),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe("listDokployDomains", () => {
  it("GETs byComposeId with the composeId query param", async () => {
    const mock = mockFetchSequence(
      jsonResponse([
        { domainId: "d1", host: "a.example.com" },
        { domainId: "d2", host: "b.example.com" },
      ]),
    );
    const result = await listDokployDomains(CFG, "compose/1");
    expect(result).toHaveLength(2);
    expect(mock.mock.calls[0]![0]).toBe(
      "http://dokploy.example.com:3000/api/domain.byComposeId?composeId=compose%2F1",
    );
    expect((mock.mock.calls[0]![1] as RequestInit).method).toBe("GET");
  });
});

describe("deleteDokployDomain", () => {
  it("POSTs {domainId}", async () => {
    const mock = mockFetchSequence(jsonResponse({ success: true }));
    await deleteDokployDomain(CFG, "d1");
    expect(mock.mock.calls[0]![0]).toBe(
      "http://dokploy.example.com:3000/api/domain.delete",
    );
    expect(
      JSON.parse((mock.mock.calls[0]![1] as RequestInit).body as string),
    ).toEqual({ domainId: "d1" });
  });

  it("swallows a 'not found' upstream error", async () => {
    mockFetchSequence(jsonResponse({ message: "Domain not found" }, 404));
    await expect(deleteDokployDomain(CFG, "ghost")).resolves.toBeUndefined();
  });

  it("re-throws non-404 upstream errors", async () => {
    mockFetchSequence(jsonResponse({ message: "nope" }, 500));
    await expect(deleteDokployDomain(CFG, "d1")).rejects.toMatchObject({
      status: 502,
    });
  });
});

describe("findDomainByHost", () => {
  it("returns a match on the same host (case-insensitive)", async () => {
    mockFetchSequence(
      jsonResponse([
        { domainId: "d1", host: "Hello.Example.COM" },
        { domainId: "d2", host: "other.example.com" },
      ]),
    );
    const hit = await findDomainByHost(CFG, "c1", "hello.example.com");
    expect(hit?.domainId).toBe("d1");
  });

  it("returns null when no match", async () => {
    mockFetchSequence(jsonResponse([{ domainId: "d1", host: "a.example.com" }]));
    await expect(findDomainByHost(CFG, "c1", "b.example.com")).resolves.toBeNull();
  });
});
