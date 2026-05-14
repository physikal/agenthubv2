import { describe, it, expect } from "vitest";
import { pickFilesToDelete, parseFilenameTimestamp } from "./retention.js";

describe("parseFilenameTimestamp", () => {
  it("extracts the timestamp from a bundle filename", () => {
    expect(
      parseFilenameTimestamp("install-agenthub.example.com-2026-05-13T14-30-00Z.tar.gz"),
    ).toBe("2026-05-13T14-30-00Z");
  });

  it("returns null for non-bundle filenames", () => {
    expect(parseFilenameTimestamp("readme.txt")).toBeNull();
  });
});

describe("pickFilesToDelete", () => {
  const files = [
    "install-x-2026-05-10T00-00-00Z.tar.gz",
    "install-x-2026-05-11T00-00-00Z.tar.gz",
    "install-x-2026-05-12T00-00-00Z.tar.gz",
    "install-x-2026-05-13T00-00-00Z.tar.gz",
    "install-x-2026-05-14T00-00-00Z.tar.gz",
  ];

  it("keeps the newest N", () => {
    expect(pickFilesToDelete(files, 2)).toEqual([
      "install-x-2026-05-10T00-00-00Z.tar.gz",
      "install-x-2026-05-11T00-00-00Z.tar.gz",
      "install-x-2026-05-12T00-00-00Z.tar.gz",
    ]);
  });

  it("returns empty when count <= N", () => {
    expect(pickFilesToDelete(files, 10)).toEqual([]);
  });

  it("returns empty when keepLast is 0 (treated as no retention)", () => {
    expect(pickFilesToDelete(files, 0)).toEqual([]);
  });

  it("ignores non-bundle files", () => {
    const mixed = ["readme.txt", ...files];
    expect(pickFilesToDelete(mixed, 2)).toHaveLength(3); // not 4
  });
});
