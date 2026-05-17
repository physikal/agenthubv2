import { describe, expect, it } from "vitest";
import { isNewer } from "./semver-cmp.js";

describe("isNewer", () => {
  it("returns true when major increases", () => {
    expect(isNewer("2.0.0", "1.9.9")).toBe(true);
  });

  it("returns true when minor increases", () => {
    expect(isNewer("1.2.0", "1.1.99")).toBe(true);
  });

  it("returns true when patch increases", () => {
    expect(isNewer("1.0.43", "1.0.40")).toBe(true);
  });

  it("returns false when versions are equal", () => {
    expect(isNewer("1.0.40", "1.0.40")).toBe(false);
  });

  it("returns false when latest is older", () => {
    expect(isNewer("1.0.39", "1.0.40")).toBe(false);
  });

  it("tolerates a leading v", () => {
    expect(isNewer("v1.0.43", "1.0.40")).toBe(true);
    expect(isNewer("1.0.43", "v1.0.40")).toBe(true);
  });

  it("treats a prerelease as older than the same release", () => {
    expect(isNewer("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(isNewer("1.0.0-rc.1", "1.0.0")).toBe(false);
  });

  it("treats prereleases ordinally by string compare", () => {
    expect(isNewer("1.0.0-rc.2", "1.0.0-rc.1")).toBe(true);
    expect(isNewer("1.0.0-rc.1", "1.0.0-rc.2")).toBe(false);
  });

  it("returns false when either argument is null or unparseable", () => {
    expect(isNewer(null, "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", null)).toBe(false);
    expect(isNewer("not-a-version", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", "not-a-version")).toBe(false);
  });
});
