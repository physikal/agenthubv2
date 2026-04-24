import { describe, it, expect } from "vitest";
import { DockerHostingProvider } from "./docker-hosting.js";

describe("DockerHostingProvider.validate", () => {
  const p = new DockerHostingProvider();

  it("accepts a plain IPv4 + private key", () => {
    const r = p.validate({ hostIp: "1.2.3.4", sshPrivateKey: "-----BEGIN..." });
    expect(r.ok).toBe(true);
  });

  it("accepts a hostname and an explicit sshUser", () => {
    const r = p.validate({
      hostIp: "host.example.com",
      sshUser: "deploy",
      sshPrivateKey: "-----BEGIN...",
    });
    expect(r.ok).toBe(true);
  });

  it("accepts a bracketed IPv6", () => {
    const r = p.validate({
      hostIp: "[::1]",
      sshPrivateKey: "-----BEGIN...",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a hostIp with shell metacharacters", () => {
    const r = p.validate({
      hostIp: "1.2.3.4; rm -rf /",
      sshPrivateKey: "-----BEGIN...",
    });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/hostIp/);
  });

  it("rejects a hostIp with whitespace", () => {
    const r = p.validate({
      hostIp: "1.2.3.4 4.3.2.1",
      sshPrivateKey: "-----BEGIN...",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an sshUser starting with '-' (ssh option-injection shape)", () => {
    const r = p.validate({
      hostIp: "1.2.3.4",
      sshUser: "-oProxyCommand=evil",
      sshPrivateKey: "-----BEGIN...",
    });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/sshUser/);
  });

  it("rejects an sshUser with shell metacharacters", () => {
    const r = p.validate({
      hostIp: "1.2.3.4",
      sshUser: "root$(whoami)",
      sshPrivateKey: "-----BEGIN...",
    });
    expect(r.ok).toBe(false);
  });

  it("treats an empty sshUser as unset (no validation error)", () => {
    const r = p.validate({
      hostIp: "1.2.3.4",
      sshUser: "",
      sshPrivateKey: "-----BEGIN...",
    });
    expect(r.ok).toBe(true);
  });

  it("requires hostIp", () => {
    const r = p.validate({ sshPrivateKey: "-----BEGIN..." });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/hostIp is required/);
  });

  it("requires sshPrivateKey", () => {
    const r = p.validate({ hostIp: "1.2.3.4" });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => /sshPrivateKey/.test(i))).toBe(true);
  });
});
