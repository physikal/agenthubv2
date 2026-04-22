import { describe, expect, it } from "vitest";
import { listCatalog, getPackage } from "./catalog.js";

describe("package catalog", () => {
  it("contains the three bundled CLIs as built-ins", () => {
    const builtins = listCatalog().filter((m) => m.isBuiltin);
    expect(builtins.map((m) => m.id).sort()).toEqual([
      "claude-code",
      "minimax",
      "opencode",
    ]);
  });

  it("contains Droid as a non-builtin curl-sh install", () => {
    const droid = getPackage("droid");
    expect(droid).toBeDefined();
    expect(droid?.isBuiltin).not.toBe(true);
    expect(droid?.install.method).toBe("curl-sh");
  });

  it("every manifest has a valid slug, binName, and versionCmd", () => {
    const slug = /^[a-z][a-z0-9-]{0,63}$/;
    const binName = /^[A-Za-z0-9._-]{1,64}$/;
    for (const m of listCatalog()) {
      expect(slug.test(m.id)).toBe(true);
      expect(binName.test(m.binName)).toBe(true);
      expect(m.versionCmd.length).toBeGreaterThan(0);
    }
  });

  it("non-npm install URLs are https-only", () => {
    for (const m of listCatalog()) {
      if (m.install.method === "curl-sh") {
        expect(m.install.scriptUrl.startsWith("https://")).toBe(true);
      } else if (m.install.method === "binary") {
        expect(m.install.url.startsWith("https://")).toBe(true);
      }
    }
  });

  it("getPackage returns undefined for unknown ids", () => {
    expect(getPackage("does-not-exist")).toBeUndefined();
  });
});
