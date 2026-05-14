import { describe, it, expect } from "vitest";
import {
  bundleFilename,
  parseBundleFilename,
  parseWorkspaceManifest,
  serializeWorkspaceManifest,
} from "./manifest.js";
import { WORKSPACE_BUNDLE_SCHEMA_VERSION } from "./types.js";

describe("workspace manifest", () => {
  const fixture = {
    schemaVersion: WORKSPACE_BUNDLE_SCHEMA_VERSION,
    createdAt: "2026-05-14T18:00:00.000Z",
    userId: "abc12345-def6-7890",
    userEmail: "user@example.com",
    workspaceImageSha: "sha256:abcdef",
    trigger: "cli" as const,
  };

  it("round-trips a manifest", () => {
    const json = serializeWorkspaceManifest(fixture);
    const parsed = parseWorkspaceManifest(json);
    expect(parsed).toEqual(fixture);
  });

  it("preserves optional note", () => {
    const json = serializeWorkspaceManifest({ ...fixture, note: "before risky" });
    expect(parseWorkspaceManifest(json).note).toBe("before risky");
  });

  it("preserves null email + null imageSha", () => {
    const noEmail = { ...fixture, userEmail: null, workspaceImageSha: null };
    expect(parseWorkspaceManifest(serializeWorkspaceManifest(noEmail))).toEqual(noEmail);
  });

  it("rejects unknown schemaVersion", () => {
    const bad = JSON.stringify({ ...fixture, schemaVersion: 99 });
    expect(() => parseWorkspaceManifest(bad)).toThrow(/schemaVersion/);
  });

  it("rejects unknown trigger", () => {
    const bad = JSON.stringify({ ...fixture, trigger: "cron" });
    expect(() => parseWorkspaceManifest(bad)).toThrow(/trigger/);
  });

  it("rejects missing required fields", () => {
    const bad = JSON.stringify({ schemaVersion: WORKSPACE_BUNDLE_SCHEMA_VERSION });
    expect(() => parseWorkspaceManifest(bad)).toThrow();
  });
});

describe("bundleFilename", () => {
  it("builds a stable filename", () => {
    expect(bundleFilename("u1", "2026-05-14T17:31:37.123Z")).toBe(
      "workspace-u1-2026-05-14T17-31-37-123Z.tar.zst",
    );
  });

  it("works with UUID userIds containing dashes", () => {
    const fn = bundleFilename(
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "2026-05-14T17:31:37.123Z",
    );
    expect(fn).toBe(
      "workspace-a1b2c3d4-e5f6-7890-abcd-ef1234567890-2026-05-14T17-31-37-123Z.tar.zst",
    );
  });
});

describe("parseBundleFilename", () => {
  it("round-trips with bundleFilename", () => {
    const ts = "2026-05-14T17:31:37.123Z";
    const userId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const fn = bundleFilename(userId, ts);
    const parsed = parseBundleFilename(fn);
    expect(parsed?.userId).toBe(userId);
    expect(parsed?.timestamp).toBe("2026-05-14T17-31-37-123Z");
  });

  it("returns null for non-bundle filenames", () => {
    expect(parseBundleFilename("random.tar.gz")).toBeNull();
    expect(parseBundleFilename("workspace-no-timestamp.tar.zst")).toBeNull();
    expect(parseBundleFilename("workspace-a1b2-not-a-timestamp.tar.zst")).toBeNull();
  });

  it("handles simple alphanumeric userId", () => {
    const fn = bundleFilename("u1", "2026-05-14T17:31:37.123Z");
    expect(parseBundleFilename(fn)).toEqual({
      userId: "u1",
      timestamp: "2026-05-14T17-31-37-123Z",
    });
  });
});
