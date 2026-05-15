import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_TOOLS, getTool } from "./registry.js";

const fixtureDir = join(__dirname, "__fixtures__");

describe("agent tool registry", () => {
  it("has unique IDs", () => {
    const ids = AGENT_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("getTool returns the entry for claude-code", () => {
    const tool = getTool("claude-code");
    expect(tool?.displayName).toBe("Claude Code");
    expect(tool?.loginCommand).toBe("claude /login");
    expect(tool?.credentialPaths).toEqual(["/home/coder/.claude/.credentials.json"]);
  });

  it("getTool returns undefined for unknown id", () => {
    expect(getTool("nope")).toBeUndefined();
  });

  it("claude-code urlPattern matches its fixture stdout", () => {
    const tool = getTool("claude-code")!;
    const stdout = readFileSync(join(fixtureDir, "claude-login-stdout.txt"), "utf8");
    const match = stdout.match(tool.urlPattern);
    expect(match).not.toBeNull();
    expect(match![0]).toContain("claude.ai/oauth/authorize");
  });
});
