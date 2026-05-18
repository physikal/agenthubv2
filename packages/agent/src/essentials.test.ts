import { describe, expect, it, vi } from "vitest";
import { ensureEssentials } from "./essentials.js";
import type { EssentialSpec } from "./packages-protocol.js";

function spec(id: string, bin: string): EssentialSpec {
  return {
    packageId: id,
    binName: bin,
    versionCmd: [bin, "--version"],
    install: { method: "npm", npmPackage: `@scope/${id}` },
  };
}

describe("ensureEssentials", () => {
  it("installs only missing binaries", async () => {
    const present = new Set(["claude"]);
    const install = vi.fn().mockResolvedValue({ ok: true, version: "1.0.0" });
    const readVersion = vi.fn().mockResolvedValue("2.1.143");
    const log = vi.fn();

    const result = await ensureEssentials(
      [spec("claude-code", "claude"), spec("opencode", "opencode"), spec("codex", "codex")],
      {
        binExists: async (bin) => present.has(bin),
        install,
        readVersion,
        log,
      },
    );

    expect(install).toHaveBeenCalledTimes(2);
    expect(install.mock.calls.map((c) => (c[0] as EssentialSpec).packageId).sort()).toEqual([
      "codex", "opencode",
    ]);
    expect(result.installed.sort()).toEqual(["codex", "opencode"]);
    expect(result.skipped).toEqual(["claude-code"]);
    expect(result.failed).toEqual([]);
  });

  it("is a no-op when every binary already exists", async () => {
    const install = vi.fn();
    const readVersion = vi.fn().mockResolvedValue("1.0.0");
    const log = vi.fn();
    const result = await ensureEssentials(
      [spec("claude-code", "claude")],
      { binExists: async () => true, install, readVersion, log },
    );
    expect(install).not.toHaveBeenCalled();
    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual(["claude-code"]);
  });

  it("reports per-package failures without aborting siblings", async () => {
    const install = vi.fn().mockImplementation(async (s: EssentialSpec) => {
      if (s.packageId === "opencode") return { ok: false, error: "npm 503" };
      return { ok: true, version: "1.0.0" };
    });
    const log = vi.fn();

    const result = await ensureEssentials(
      [spec("claude-code", "claude"), spec("opencode", "opencode"), spec("codex", "codex")],
      { binExists: async () => false, install, log },
    );
    expect(install).toHaveBeenCalledTimes(3);
    expect(result.installed.sort()).toEqual(["claude-code", "codex"]);
    expect(result.failed).toEqual(["opencode"]);
  });

  it("handles install thrown errors as per-package failures", async () => {
    const install = vi.fn().mockRejectedValue(new Error("disk full"));
    const log = vi.fn();
    const result = await ensureEssentials(
      [spec("claude-code", "claude")],
      { binExists: async () => false, install, log },
    );
    expect(result.failed).toEqual(["claude-code"]);
    expect(result.installed).toEqual([]);
  });

  it("emits onResult for each installed, skipped, and failed package", async () => {
    const install = vi.fn().mockImplementation(async (s: EssentialSpec) => {
      if (s.packageId === "opencode") return { ok: false, error: "npm 503" };
      return { ok: true, version: "1.0.0" };
    });
    const readVersion = vi.fn().mockResolvedValue("9.9.9");
    const onResult = vi.fn();
    const log = vi.fn();

    await ensureEssentials(
      [spec("claude-code", "claude"), spec("opencode", "opencode"), spec("codex", "codex")],
      {
        // claude is already installed → skip path; opencode + codex need install.
        binExists: async (bin) => bin === "claude",
        install,
        readVersion,
        onResult,
        log,
      },
    );

    expect(onResult).toHaveBeenCalledTimes(3);
    const byPackage = new Map(
      onResult.mock.calls.map((c) => [
        (c[0] as { packageId: string }).packageId,
        c[0] as { packageId: string; ok: boolean; version?: string; error?: string },
      ]),
    );
    expect(byPackage.get("claude-code")).toEqual({ packageId: "claude-code", ok: true, version: "9.9.9" });
    expect(byPackage.get("codex")).toEqual({ packageId: "codex", ok: true, version: "1.0.0" });
    expect(byPackage.get("opencode")).toEqual({ packageId: "opencode", ok: false, error: "npm 503" });
  });

  it("emits onResult for skipped packages even if readVersion throws", async () => {
    const onResult = vi.fn();
    await ensureEssentials(
      [spec("claude-code", "claude")],
      {
        binExists: async () => true,
        install: vi.fn(),
        readVersion: async () => { throw new Error("transient stat error"); },
        onResult,
        log: vi.fn(),
      },
    );
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0]?.[0]).toEqual({ packageId: "claude-code", ok: true });
  });
});
