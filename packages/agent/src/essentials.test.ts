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
    const log = vi.fn();

    const result = await ensureEssentials(
      [spec("claude-code", "claude"), spec("opencode", "opencode"), spec("codex", "codex")],
      {
        binExists: async (bin) => present.has(bin),
        install,
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
    const log = vi.fn();
    const result = await ensureEssentials(
      [spec("claude-code", "claude")],
      { binExists: async () => true, install, log },
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
});
