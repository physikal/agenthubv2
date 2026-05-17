import { describe, expect, it } from "vitest";
import { extractSemver, validatePackageOpParams, type PackageOpParams } from "./package-ops.js";

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

describe("extractSemver", () => {
  it("extracts the bare semver from claude --version output", () => {
    // claude prints `2.1.143 (Claude Code)` — the suffix used to leak through.
    expect(extractSemver("2.1.143 (Claude Code)")).toBe("2.1.143");
  });

  it("extracts semver from codex --version output", () => {
    // codex prints `codex-cli 0.130.0`, sometimes preceded by a PATH warning.
    expect(extractSemver("codex-cli 0.130.0")).toBe("0.130.0");
    expect(
      extractSemver(
        "WARNING: proceeding, even though we could not update PATH: Permission denied (os error 13)\ncodex-cli 0.130.0",
      ),
    ).toBe("0.130.0");
  });

  it("strips a leading v prefix to match npm-registry shape", () => {
    expect(extractSemver("v1.0.40")).toBe("1.0.40");
  });

  it("passes through plain semver unchanged", () => {
    expect(extractSemver("1.15.3")).toBe("1.15.3");
  });

  it("preserves a prerelease segment", () => {
    expect(extractSemver("1.2.3-beta.4")).toBe("1.2.3-beta.4");
  });

  it("falls back to the trimmed first line when no semver token is present", () => {
    // Non-standard tools that don't print a semver still report SOMETHING —
    // server-side isNewer is safe against these (returns false).
    expect(extractSemver("nightly-build")).toBe("nightly-build");
  });

  it("returns null for empty output", () => {
    expect(extractSemver("")).toBeNull();
    expect(extractSemver("   \n\n  ")).toBeNull();
  });

  it("caps the fallback at 128 chars to bound DB storage", () => {
    const long = "x".repeat(200);
    const got = extractSemver(long);
    expect(got).not.toBeNull();
    expect(got!.length).toBeLessThanOrEqual(128);
  });
});
