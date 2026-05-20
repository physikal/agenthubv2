import { describe, it, expect, vi, beforeEach } from "vitest";

const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

import { assertSafeProviderUrl, BlockedOutboundHostError } from "./ssrf-guard.js";

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

describe("assertSafeProviderUrl — literal IPs (no DNS)", () => {
  it("blocks the cloud metadata endpoint", async () => {
    await expect(
      assertSafeProviderUrl("http://169.254.169.254/latest/meta-data/iam/"),
    ).rejects.toBeInstanceOf(BlockedOutboundHostError);
  });

  it("blocks IPv4 loopback", async () => {
    await expect(assertSafeProviderUrl("http://127.0.0.1:8080/x")).rejects.toBeInstanceOf(
      BlockedOutboundHostError,
    );
  });

  it("blocks IPv6 loopback and link-local", async () => {
    await expect(assertSafeProviderUrl("http://[::1]:8080/x")).rejects.toBeInstanceOf(
      BlockedOutboundHostError,
    );
    await expect(assertSafeProviderUrl("http://[fe80::1]/x")).rejects.toBeInstanceOf(
      BlockedOutboundHostError,
    );
  });

  it("allows a public IPv4 literal", async () => {
    await expect(assertSafeProviderUrl("https://8.8.8.8/x")).resolves.toBeUndefined();
  });

  it("allows RFC1918 private addresses (LAN Dokploy/AI must keep working)", async () => {
    for (const ip of ["192.168.1.10", "10.0.0.5", "172.16.4.4", "172.31.255.255"]) {
      await expect(assertSafeProviderUrl(`http://${ip}:3000/api`)).resolves.toBeUndefined();
    }
  });
});

describe("assertSafeProviderUrl — hostname resolution", () => {
  it("blocks a hostname that resolves to the metadata IP", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(
      assertSafeProviderUrl("https://metadata.attacker.example/x"),
    ).rejects.toBeInstanceOf(BlockedOutboundHostError);
  });

  it("allows a hostname that resolves to a public address", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(
      assertSafeProviderUrl("https://api.anthropic.com/v1/models"),
    ).resolves.toBeUndefined();
  });

  it("passes through when resolution fails (the fetch surfaces the error)", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertSafeProviderUrl("https://nope.invalid/x")).resolves.toBeUndefined();
  });
});

describe("assertSafeProviderUrl — malformed input", () => {
  it("passes through a malformed URL", async () => {
    await expect(assertSafeProviderUrl("not a url")).resolves.toBeUndefined();
  });
});
