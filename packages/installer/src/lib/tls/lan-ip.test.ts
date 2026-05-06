import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";

const networkInterfacesMock = vi.hoisted(() => vi.fn());

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    networkInterfaces: networkInterfacesMock,
  };
});

import { detectLanIp } from "./lan-ip.js";

describe("detectLanIp", () => {
  beforeEach(() => {
    networkInterfacesMock.mockReset();
  });

  it("returns the first non-loopback IPv4 address", () => {
    networkInterfacesMock.mockReturnValue({
      lo: [
        { address: "127.0.0.1", family: "IPv4", internal: true } as NetworkInterfaceInfo,
      ],
      eth0: [
        { address: "192.168.4.36", family: "IPv4", internal: false } as NetworkInterfaceInfo,
      ],
    });
    expect(detectLanIp()).toBe("192.168.4.36");
  });

  it("prefers RFC1918 ranges over public IPs", () => {
    networkInterfacesMock.mockReturnValue({
      eth0: [
        { address: "8.8.8.8", family: "IPv4", internal: false } as NetworkInterfaceInfo,
      ],
      eth1: [
        { address: "192.168.1.5", family: "IPv4", internal: false } as NetworkInterfaceInfo,
      ],
    });
    expect(detectLanIp()).toBe("192.168.1.5");
  });

  it("falls back to first non-loopback when no RFC1918 present", () => {
    networkInterfacesMock.mockReturnValue({
      eth0: [
        { address: "8.8.8.8", family: "IPv4", internal: false } as NetworkInterfaceInfo,
      ],
    });
    expect(detectLanIp()).toBe("8.8.8.8");
  });

  it("returns 127.0.0.1 when only loopback present", () => {
    networkInterfacesMock.mockReturnValue({
      lo: [
        { address: "127.0.0.1", family: "IPv4", internal: true } as NetworkInterfaceInfo,
      ],
    });
    expect(detectLanIp()).toBe("127.0.0.1");
  });
});
