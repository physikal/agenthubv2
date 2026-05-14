import { describe, it, expect } from "vitest";
import { computeConflicts } from "./conflict.js";

describe("computeConflicts", () => {
  const baseState = {
    userCount: 0,
    secretCount: 0,
    activeSessionCount: 0,
    currentEnvEncryptionKey: "AAA",
    bundleEnvEncryptionKey: "AAA",
  };

  it("returns ok when install is fresh", () => {
    const r = computeConflicts(baseState);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
  });

  it("flags users-exist", () => {
    const r = computeConflicts({ ...baseState, userCount: 5 });
    expect(r.ok).toBe(false);
    expect(r.conflicts).toContainEqual(
      expect.objectContaining({ kind: "users-exist" }),
    );
  });

  it("flags secrets-exist", () => {
    const r = computeConflicts({ ...baseState, secretCount: 12 });
    expect(r.ok).toBe(false);
    expect(r.conflicts).toContainEqual(
      expect.objectContaining({ kind: "secrets-exist" }),
    );
  });

  it("flags active-sessions", () => {
    const r = computeConflicts({ ...baseState, activeSessionCount: 1 });
    expect(r.ok).toBe(false);
    expect(r.conflicts).toContainEqual(
      expect.objectContaining({ kind: "active-sessions" }),
    );
  });

  it("flags encryption-key-mismatch ONLY when secrets exist", () => {
    const noSecrets = computeConflicts({
      ...baseState,
      currentEnvEncryptionKey: "AAA",
      bundleEnvEncryptionKey: "BBB",
    });
    expect(noSecrets.conflicts.find((c) => c.kind === "encryption-key-mismatch")).toBeUndefined();

    const withSecrets = computeConflicts({
      ...baseState,
      secretCount: 5,
      currentEnvEncryptionKey: "AAA",
      bundleEnvEncryptionKey: "BBB",
    });
    expect(withSecrets.conflicts.find((c) => c.kind === "encryption-key-mismatch")).toBeDefined();
  });
});
