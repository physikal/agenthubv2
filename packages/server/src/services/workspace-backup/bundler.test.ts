import { describe, it, expect } from "vitest";
import { buildBundleShellCommand, WORKSPACE_EXCLUDES } from "./bundler.js";

describe("buildBundleShellCommand", () => {
  it("writes the manifest first, then appends the volume with excludes", () => {
    const cmd = buildBundleShellCommand();
    expect(cmd.indexOf("agenthub-workspace-manifest.json")).toBeLessThan(cmd.indexOf("-C /src"));
    for (const ex of WORKSPACE_EXCLUDES) {
      expect(cmd).toContain(`--exclude=${ex}`);
    }
    expect(cmd).toContain("zstd -T0 -19");
  });

  it("excludes node_modules anywhere and .cache/.local at the home root", () => {
    expect(WORKSPACE_EXCLUDES).toContain("node_modules");
    expect(WORKSPACE_EXCLUDES).toContain("./.cache");
    expect(WORKSPACE_EXCLUDES).toContain("./.local");
  });
});
