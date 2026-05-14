import { describe, it, expect } from "vitest";
import { serializeManifest, parseManifest } from "./manifest.js";
import { BUNDLE_SCHEMA_VERSION } from "./types.js";

describe("manifest", () => {
  const fixture = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    createdAt: "2026-05-13T14:30:00.000Z",
    sourceDomain: "agenthub.example.com",
    gitSha: "abc123def456",
    composeVersion: "v2",
    trigger: "manual" as const,
    note: "before risky change",
  };

  it("round-trips a manifest", () => {
    const json = serializeManifest(fixture);
    const parsed = parseManifest(json);
    expect(parsed).toEqual(fixture);
  });

  it("rejects unknown schemaVersion", () => {
    const bad = JSON.stringify({ ...fixture, schemaVersion: 99 });
    expect(() => parseManifest(bad)).toThrow(/schemaVersion/);
  });

  it("rejects missing required fields", () => {
    const bad = JSON.stringify({ schemaVersion: BUNDLE_SCHEMA_VERSION });
    expect(() => parseManifest(bad)).toThrow();
  });

  it("rejects unknown trigger", () => {
    const bad = JSON.stringify({ ...fixture, trigger: "cron" });
    expect(() => parseManifest(bad)).toThrow(/trigger/);
  });

  it("accepts missing optional note", () => {
    const { note: _, ...withoutNote } = fixture;
    const json = serializeManifest(withoutNote);
    const parsed = parseManifest(json);
    expect(parsed.note).toBeUndefined();
  });
});
