import { describe, it, expect } from "vitest";
import { volumeNameForUser } from "./volume.js";

describe("volumeNameForUser", () => {
  it("builds canonical name for alphanumeric userId", () => {
    expect(volumeNameForUser("u1")).toBe("agenthub-home-u1");
  });

  it("accepts UUID userIds (dashes ok)", () => {
    const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    expect(volumeNameForUser(id)).toBe(`agenthub-home-${id}`);
  });

  it("rejects userIds with shell metacharacters", () => {
    expect(() => volumeNameForUser("u1; rm -rf /")).toThrow(/unsafe/);
    expect(() => volumeNameForUser("u1$VAR")).toThrow(/unsafe/);
    expect(() => volumeNameForUser("u1/../../etc")).toThrow(/unsafe/);
    expect(() => volumeNameForUser("u1 u2")).toThrow(/unsafe/);
  });

  it("rejects empty userId", () => {
    expect(() => volumeNameForUser("")).toThrow(/unsafe/);
  });
});
