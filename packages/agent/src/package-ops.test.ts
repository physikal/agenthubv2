import { describe, expect, it } from "vitest";
import { validatePackageOpParams, type PackageOpParams } from "./package-ops.js";

function baseParams(overrides: Partial<PackageOpParams> = {}): PackageOpParams {
  return {
    packageId: "droid",
    binName: "droid",
    versionCmd: ["droid", "--version"],
    spec: { method: "curl-sh", scriptUrl: "https://app.factory.ai/cli" },
    ...overrides,
  };
}

describe("validatePackageOpParams", () => {
  it("accepts valid curl-sh params", () => {
    expect(validatePackageOpParams(baseParams())).toBeNull();
  });

  it("accepts valid npm params", () => {
    expect(
      validatePackageOpParams(
        baseParams({
          packageId: "claude-code",
          binName: "claude",
          versionCmd: ["claude", "--version"],
          spec: { method: "npm", npmPackage: "@anthropic-ai/claude-code" },
        }),
      ),
    ).toBeNull();
  });

  it("rejects http (non-https) install script URLs", () => {
    expect(
      validatePackageOpParams(
        baseParams({ spec: { method: "curl-sh", scriptUrl: "http://evil.test/install.sh" } }),
      ),
    ).toBe("invalid scriptUrl");
  });

  it("rejects non-URL-shaped input in scriptUrl", () => {
    expect(
      validatePackageOpParams(
        baseParams({ spec: { method: "curl-sh", scriptUrl: "https://example.com/$(rm -rf /)" } }),
      ),
    ).toBe("invalid scriptUrl");
  });

  it("rejects path-traversal / shell metachars in binName", () => {
    for (const bad of ["../evil", "foo;ls", "a b", "foo/bar", ""]) {
      expect(validatePackageOpParams(baseParams({ binName: bad }))).toBe("invalid binName");
    }
  });

  it("rejects bogus packageIds", () => {
    for (const bad of ["UPPER", "has space", "1-starts-with-digit", ""]) {
      expect(validatePackageOpParams(baseParams({ packageId: bad }))).toBe("invalid packageId");
    }
  });

  it("rejects empty versionCmd", () => {
    expect(validatePackageOpParams(baseParams({ versionCmd: [] }))).toBe("invalid versionCmd");
  });

  it("rejects invalid npm package names", () => {
    expect(
      validatePackageOpParams(
        baseParams({
          binName: "claude",
          spec: { method: "npm", npmPackage: "../etc/passwd" },
        }),
      ),
    ).toBe("invalid npmPackage");
  });

  it("rejects scriptEnv keys that aren't SCREAMING_SNAKE", () => {
    expect(
      validatePackageOpParams(
        baseParams({
          spec: {
            method: "curl-sh",
            scriptUrl: "https://app.factory.ai/cli",
            scriptEnv: { "not-upper": "x" },
          },
        }),
      ),
    ).toBe("invalid scriptEnv key");
  });
});
