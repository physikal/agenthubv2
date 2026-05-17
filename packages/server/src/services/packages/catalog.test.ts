import { describe, expect, it } from "vitest";
import { listCatalog, getPackage } from "./catalog.js";

describe("package catalog", () => {
  it("marks claude-code, opencode, and codex as essentials", () => {
    const essentials = listCatalog().filter((m) => m.essential);
    expect(essentials.map((m) => m.id).sort()).toEqual([
      "claude-code",
      "codex",
      "opencode",
    ]);
  });

  it("contains MiniMax and Droid as non-essential opt-ins", () => {
    const minimax = getPackage("minimax");
    const droid = getPackage("droid");
    expect(minimax?.essential).toBeFalsy();
    expect(droid?.essential).toBeFalsy();
    expect(droid?.install.method).toBe("curl-sh");
  });

  it("no manifest is marked isBuiltin anymore", () => {
    for (const m of listCatalog()) {
      expect(m.isBuiltin).toBeFalsy();
    }
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
