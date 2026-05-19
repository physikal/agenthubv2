import { describe, expect, it } from "vitest";
import { tryAcquireUpdateLock, releaseUpdateLock } from "./update-lock.js";

describe("update-lock", () => {
  it("second acquire fails while the first holder hasn't released", () => {
    const a = tryAcquireUpdateLock("agenthub");
    expect(a).toBe(true);
    const b = tryAcquireUpdateLock("image");
    expect(b).toBe(false);
    releaseUpdateLock();
    const c = tryAcquireUpdateLock("image");
    expect(c).toBe(true);
    releaseUpdateLock();
  });

  it("releasing without a holder is a no-op", () => {
    releaseUpdateLock();
    expect(tryAcquireUpdateLock("image")).toBe(true);
    releaseUpdateLock();
  });
});
