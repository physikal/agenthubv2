import { describe, it, expect } from "vitest";
import { createServer } from "node:net";
import { portIsFree } from "./prereq.js";

function listenOn(port: number): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(port, "0.0.0.0", () => resolve(() => s.close()));
  });
}

describe("portIsFree", () => {
  it("returns true for an unused high port", async () => {
    expect(await portIsFree(53219)).toBe(true);
  });

  it("returns false when something is already listening (EADDRINUSE)", async () => {
    const close = await listenOn(53221);
    try {
      expect(await portIsFree(53221)).toBe(false);
    } finally {
      close();
    }
  });
});
