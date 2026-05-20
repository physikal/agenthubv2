import { describe, it, expect } from "vitest";
import { pickBundlesToDelete } from "./retention.js";

const f = (ts: string) => `workspace-u1-${ts}.tar.zst`;

describe("pickBundlesToDelete", () => {
  it("keeps the newest N, returns the rest (oldest first)", () => {
    const names = [
      f("2026-05-01T00-00-00-000Z"),
      f("2026-05-03T00-00-00-000Z"),
      f("2026-05-02T00-00-00-000Z"),
    ];
    expect(pickBundlesToDelete(names, 2)).toEqual([f("2026-05-01T00-00-00-000Z")]);
  });

  it("returns [] when at or under the limit", () => {
    expect(pickBundlesToDelete([f("2026-05-01T00-00-00-000Z")], 10)).toEqual([]);
  });

  it("ignores non-bundle filenames", () => {
    expect(pickBundlesToDelete(["README.md", f("2026-05-01T00-00-00-000Z")], 0))
      .toEqual([f("2026-05-01T00-00-00-000Z")]);
  });

  it("keepLast<=0 deletes all bundles", () => {
    expect(pickBundlesToDelete([f("2026-05-01T00-00-00-000Z")], 0))
      .toEqual([f("2026-05-01T00-00-00-000Z")]);
  });
});
