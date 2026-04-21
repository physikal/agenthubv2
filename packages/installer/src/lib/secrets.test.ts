import { describe, expect, it } from "vitest";
import { randomHex, randomPassword } from "./secrets.js";

describe("randomHex", () => {
  it("emits exactly 2*n hex chars", () => {
    expect(randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(randomHex(32)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is different each call", () => {
    expect(randomHex(16)).not.toBe(randomHex(16));
  });
});

describe("randomPassword", () => {
  it("emits the requested length", () => {
    expect(randomPassword(12)).toHaveLength(12);
    expect(randomPassword(32)).toHaveLength(32);
  });
  it("uses only characters safe for shell/env parsing", () => {
    const pw = randomPassword(200);
    expect(pw).not.toMatch(/[/+=\n\r$`"']/);
  });
});
