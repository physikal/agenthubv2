import { describe, expect, it } from "vitest";
import {
  PIN_POLICY,
  classify,
  newestWithinMajor,
  newestAcrossMajor,
  parsePinnedRef,
} from "./pin-policy.js";

describe("classify", () => {
  it("parses traefik semver tags", () => {
    expect(classify("v3.6", PIN_POLICY.traefik)).toMatchObject({ major: 3, minor: 6, patch: 0 });
    expect(classify("v3.7.1", PIN_POLICY.traefik)).toMatchObject({ major: 3, minor: 7, patch: 1 });
    expect(classify("v4.0", PIN_POLICY.traefik)).toMatchObject({ major: 4 });
  });

  it("rejects non-matching traefik tags", () => {
    expect(classify("latest", PIN_POLICY.traefik)).toBe("unknown");
    expect(classify("v3.6.4-rc1", PIN_POLICY.traefik)).toBe("unknown");
    expect(classify("3.6", PIN_POLICY.traefik)).toBe("unknown");
  });

  it("parses postgres alpine + non-alpine tags, preserving variant", () => {
    expect(classify("16-alpine", PIN_POLICY.postgres)).toMatchObject({
      major: 16, minor: 0, patch: 0, variant: "-alpine",
    });
    expect(classify("16.4-alpine", PIN_POLICY.postgres)).toMatchObject({
      major: 16, minor: 4, patch: 0, variant: "-alpine",
    });
    expect(classify("16.4.1", PIN_POLICY.postgres)).toMatchObject({
      major: 16, minor: 4, patch: 1, variant: undefined,
    });
  });
});

describe("newestWithinMajor", () => {
  it("returns the newest tag within the requested major + matching variant", () => {
    const tags = [
      classify("16-alpine", PIN_POLICY.postgres),
      classify("16.2-alpine", PIN_POLICY.postgres),
      classify("16.4-alpine", PIN_POLICY.postgres),
      classify("16.4", PIN_POLICY.postgres),  // wrong variant
      classify("17-alpine", PIN_POLICY.postgres),  // wrong major
    ].filter((p) => p !== "unknown");
    const result = newestWithinMajor(tags, 16, "-alpine");
    expect(result?.raw).toBe("16.4-alpine");
  });

  it("returns null when no in-major tags newer than the pinned tag exist", () => {
    const tags = [classify("v3.6", PIN_POLICY.traefik)].filter((p) => p !== "unknown");
    const pinned = classify("v3.6", PIN_POLICY.traefik);
    expect(newestWithinMajor(tags, 3, undefined, pinned === "unknown" ? undefined : pinned)).toBeNull();
  });
});

describe("newestAcrossMajor", () => {
  it("returns the newest tag with major > pinnedMajor", () => {
    const tags = [
      classify("v3.6", PIN_POLICY.traefik),
      classify("v3.7.1", PIN_POLICY.traefik),
      classify("v4.0", PIN_POLICY.traefik),
      classify("v4.1.2", PIN_POLICY.traefik),
    ].filter((p) => p !== "unknown");
    const result = newestAcrossMajor(tags, 3);
    expect(result?.raw).toBe("v4.1.2");
  });

  it("returns null when no higher major exists", () => {
    const tags = [classify("v3.6", PIN_POLICY.traefik), classify("v3.7", PIN_POLICY.traefik)]
      .filter((p) => p !== "unknown");
    expect(newestAcrossMajor(tags, 3)).toBeNull();
  });
});

describe("parsePinnedRef", () => {
  it("splits image:tag", () => {
    expect(parsePinnedRef("traefik:v3.6")).toEqual({ image: "traefik", tag: "v3.6" });
    expect(parsePinnedRef("infisical/infisical:latest-postgres")).toEqual({
      image: "infisical/infisical", tag: "latest-postgres",
    });
  });

  it("defaults to 'latest' when no tag", () => {
    expect(parsePinnedRef("traefik")).toEqual({ image: "traefik", tag: "latest" });
  });
});
