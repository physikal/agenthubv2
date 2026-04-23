import { describe, expect, it } from "vitest";

import { DeployError } from "./deploy-error.js";

describe("DeployError", () => {
  it("defaults to status 400", () => {
    const err = new DeployError("bad input");
    expect(err.message).toBe("bad input");
    expect(err.status).toBe(400);
    expect(err.name).toBe("DeployError");
    expect(err).toBeInstanceOf(Error);
  });

  it("accepts custom status for upstream/state errors", () => {
    expect(new DeployError("upstream broke", 502).status).toBe(502);
    expect(new DeployError("not ready", 409).status).toBe(409);
    expect(new DeployError("not found", 404).status).toBe(404);
  });

  it("is caught as Error but distinguishable via instanceof", () => {
    try {
      throw new DeployError("no gitUrl");
    } catch (e) {
      expect(e instanceof DeployError).toBe(true);
      expect(e instanceof Error).toBe(true);
    }
  });
});
