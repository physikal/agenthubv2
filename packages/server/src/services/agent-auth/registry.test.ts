import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AGENT_TOOLS, getTool } from "./registry.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

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

describe("codex tool", () => {
  it("is registered with the right login command", () => {
    const tool = getTool("codex")!;
    expect(tool.loginCommand).toBe("codex login");
    expect(tool.credentialPaths).toEqual(["/home/coder/.codex/auth.json"]);
  });

  it("urlPattern matches codex stdout fixture", () => {
    const tool = getTool("codex")!;
    const stdout = readFileSync(join(fixtureDir, "codex-login-stdout.txt"), "utf8");
    const match = stdout.match(tool.urlPattern);
    expect(match).not.toBeNull();
    expect(match![0]).toContain("auth.openai.com");
  });
});

describe("gh tool", () => {
  it("is registered with the right login command", () => {
    const tool = getTool("gh")!;
    expect(tool.loginCommand).toBe("gh auth login --web --hostname github.com");
    expect(tool.credentialPaths).toContain("/home/coder/.config/gh/hosts.yml");
  });

  it("urlPattern matches gh stdout fixture", () => {
    const tool = getTool("gh")!;
    const stdout = readFileSync(join(fixtureDir, "gh-auth-stdout.txt"), "utf8");
    expect(stdout).toMatch(tool.urlPattern);
  });
});
