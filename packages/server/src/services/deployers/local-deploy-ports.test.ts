import { describe, expect, it } from "vitest";

import { firstPublishedTcpPort, parseComposePs } from "./local-deploy-ports.js";

describe("parseComposePs", () => {
  it("parses a JSON-array payload (modern compose)", () => {
    const out = parseComposePs(
      JSON.stringify([
        { Publishers: [{ PublishedPort: 8001, Protocol: "tcp" }] },
        { Publishers: [] },
      ]),
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.Publishers?.[0]?.PublishedPort).toBe(8001);
  });

  it("parses NDJSON (older compose releases)", () => {
    const out = parseComposePs(
      [
        '{"Publishers":[{"PublishedPort":8001,"Protocol":"tcp","URL":"0.0.0.0"}]}',
        '{"Publishers":[{"PublishedPort":8002,"Protocol":"tcp","URL":"0.0.0.0"}]}',
      ].join("\n"),
    );
    expect(out).toHaveLength(2);
  });

  it("returns [] on empty output", () => {
    expect(parseComposePs("")).toEqual([]);
    expect(parseComposePs("   \n  ")).toEqual([]);
  });
});

describe("firstPublishedTcpPort", () => {
  it("picks the first external TCP port", () => {
    expect(
      firstPublishedTcpPort([
        { Publishers: [{ URL: "0.0.0.0", Protocol: "tcp", PublishedPort: 32768 }] },
      ]),
    ).toBe(32768);
  });

  it("prefers an external-bound port over a localhost-only one", () => {
    expect(
      firstPublishedTcpPort([
        { Publishers: [{ URL: "127.0.0.1", Protocol: "tcp", PublishedPort: 8001 }] },
        { Publishers: [{ URL: "::", Protocol: "tcp", PublishedPort: 8002 }] },
      ]),
    ).toBe(8002);
  });

  it("falls back to a localhost-only port if nothing external is published", () => {
    expect(
      firstPublishedTcpPort([
        { Publishers: [{ URL: "127.0.0.1", Protocol: "tcp", PublishedPort: 8001 }] },
      ]),
    ).toBe(8001);
  });

  it("ignores UDP publishers", () => {
    expect(
      firstPublishedTcpPort([
        { Publishers: [{ URL: "0.0.0.0", Protocol: "udp", PublishedPort: 5353 }] },
      ]),
    ).toBeNull();
  });

  it("ignores zero / missing published ports", () => {
    expect(
      firstPublishedTcpPort([
        { Publishers: [{ Protocol: "tcp", PublishedPort: 0 }] },
        { Publishers: [{ Protocol: "tcp" }] },
      ]),
    ).toBeNull();
  });

  it("handles services without Publishers entries", () => {
    expect(firstPublishedTcpPort([{}])).toBeNull();
    expect(firstPublishedTcpPort([])).toBeNull();
  });

  it("accepts the first external over subsequent ones — order matters", () => {
    expect(
      firstPublishedTcpPort([
        { Publishers: [{ URL: "0.0.0.0", Protocol: "tcp", PublishedPort: 8001 }] },
        { Publishers: [{ URL: "0.0.0.0", Protocol: "tcp", PublishedPort: 8002 }] },
      ]),
    ).toBe(8001);
  });
});
