import { describe, expect, it } from "vitest";
import { agentCredentialPath, validateUserId, validateToolId } from "./paths.js";

describe("agent-auth paths", () => {
  it("builds the per-user per-tool credential path", () => {
    expect(agentCredentialPath("user-abc", "claude-code"))
      .toBe("/users/user-abc/agents/claude-code");
  });

  it("rejects user IDs with path traversal characters", () => {
    expect(() => validateUserId("../etc")).toThrow();
    expect(() => validateUserId("user/abc")).toThrow();
    expect(() => validateUserId("user abc")).toThrow();
  });

  it("rejects tool IDs that aren't kebab-case alphanum", () => {
    expect(() => validateToolId("Claude Code")).toThrow();
    expect(() => validateToolId("../oops")).toThrow();
    expect(validateToolId("claude-code")).toBe("claude-code");
  });
});
