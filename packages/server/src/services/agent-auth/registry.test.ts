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
    expect(tool?.loginCommand).toBe("claude auth login --claudeai");
    expect(tool?.credentialPaths).toEqual(["/home/coder/.claude/.credentials.json"]);
    expect(tool?.acceptsCodeInput).toBe(true);
  });

  it("getTool returns undefined for unknown id", () => {
    expect(getTool("nope")).toBeUndefined();
  });

  it("claude-code urlPattern matches its fixture stdout", () => {
    const tool = getTool("claude-code")!;
    const stdout = readFileSync(join(fixtureDir, "claude-login-stdout.txt"), "utf8");
    const match = stdout.match(tool.urlPattern);
    expect(match).not.toBeNull();
    expect(match![0]).toContain("claude.com/cai/oauth/authorize");
  });
});

describe("codex tool", () => {
  it("is registered with --device-auth login command", () => {
    const tool = getTool("codex")!;
    expect(tool.loginCommand).toBe("codex login --device-auth");
    expect(tool.credentialPaths).toEqual(["/home/coder/.codex/auth.json"]);
  });

  it("urlPattern matches codex device-auth stdout fixture", () => {
    const tool = getTool("codex")!;
    const stdout = readFileSync(join(fixtureDir, "codex-login-stdout.txt"), "utf8");
    const match = stdout.match(tool.urlPattern);
    expect(match).not.toBeNull();
    expect(match![0]).toContain("auth.openai.com/codex/device");
  });

  it("codePattern extracts the device code from codex fixture", () => {
    const tool = getTool("codex")!;
    const stdout = readFileSync(join(fixtureDir, "codex-login-stdout.txt"), "utf8");
    const match = stdout.match(tool.codePattern!);
    expect(match).not.toBeNull();
    expect(match![0]).toBe("34J7-3WML1");
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

  it("codePattern extracts the device code from gh fixture", () => {
    const tool = getTool("gh")!;
    const stdout = readFileSync(join(fixtureDir, "gh-auth-stdout.txt"), "utf8");
    const match = stdout.match(tool.codePattern!);
    expect(match).not.toBeNull();
    expect(match![0]).toBe("ABCD-1234");
  });
});
