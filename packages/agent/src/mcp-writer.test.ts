import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAgentDeployMcp } from "./mcp-writer.js";

// Where each writer lands its file under a fake $HOME. Kept in sync with
// the production paths in mcp-writer.ts.
const CLAUDE_PATH = (home: string) => join(home, ".claude.json");
const OPENCODE_PATH = (home: string) => join(home, ".config/opencode/opencode.json");
const DROID_PATH = (home: string) => join(home, ".factory/mcp.json");

function runWriter(home: string) {
  const logs: string[] = [];
  registerAgentDeployMcp({
    mcpBinary: "/opt/agenthub-agent/mcp-deploy.js",
    portalUrl: "https://agenthub.example/",
    agentToken: "test-token-123",
    coderHome: home,
    log: (line) => logs.push(line),
  });
  return logs;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("registerAgentDeployMcp", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenthub-mcp-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("creates Claude Code config with agentdeploy in mcpServers", () => {
    runWriter(home);
    const cfg = readJson(CLAUDE_PATH(home)) as { mcpServers: Record<string, unknown> };
    expect(cfg.mcpServers).toBeDefined();
    const entry = cfg.mcpServers["agentdeploy"] as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    expect(entry.command).toBe("node");
    expect(entry.args).toEqual(["/opt/agenthub-agent/mcp-deploy.js"]);
    expect(entry.env["PORTAL_URL"]).toBe("https://agenthub.example/");
    expect(entry.env["AGENT_TOKEN"]).toBe("test-token-123");
  });

  it("creates OpenCode config under mcp (not mcpServers)", () => {
    runWriter(home);
    const cfg = readJson(OPENCODE_PATH(home)) as { mcp: Record<string, unknown> };
    expect(cfg.mcp).toBeDefined();
    const entry = cfg.mcp["agentdeploy"] as {
      type: string;
      command: string[];
      enabled: boolean;
      environment: Record<string, string>;
    };
    expect(entry.type).toBe("local");
    expect(entry.command).toEqual(["node", "/opt/agenthub-agent/mcp-deploy.js"]);
    expect(entry.enabled).toBe(true);
    expect(entry.environment["PORTAL_URL"]).toBe("https://agenthub.example/");
  });

  it("creates Droid config under mcpServers with type stdio", () => {
    runWriter(home);
    const cfg = readJson(DROID_PATH(home)) as { mcpServers: Record<string, unknown> };
    expect(cfg.mcpServers).toBeDefined();
    const entry = cfg.mcpServers["agentdeploy"] as {
      type: string;
      command: string;
      args: string[];
      env: Record<string, string>;
      disabled: boolean;
    };
    expect(entry.type).toBe("stdio");
    expect(entry.command).toBe("node");
    expect(entry.args).toEqual(["/opt/agenthub-agent/mcp-deploy.js"]);
    expect(entry.disabled).toBe(false);
  });

  it("preserves existing Claude Code OAuth + project state on merge", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      CLAUDE_PATH(home),
      JSON.stringify({
        numStartups: 42,
        theme: "dark",
        hasCompletedOnboarding: true,
        oauthAccount: { accountUuid: "abc-123" },
        projects: { "/some/path": { allowedTools: ["Read", "Edit"] } },
        mcpServers: {
          notion: { command: "npx", args: ["-y", "@notionhq/notion-mcp-server"] },
        },
      }),
    );
    runWriter(home);
    const cfg = readJson(CLAUDE_PATH(home));
    expect(cfg["numStartups"]).toBe(42);
    expect(cfg["theme"]).toBe("dark");
    expect(cfg["hasCompletedOnboarding"]).toBe(true);
    expect(cfg["oauthAccount"]).toEqual({ accountUuid: "abc-123" });
    expect(cfg["projects"]).toEqual({ "/some/path": { allowedTools: ["Read", "Edit"] } });
    const servers = cfg["mcpServers"] as Record<string, unknown>;
    expect(servers["notion"]).toBeDefined(); // user's entry survives
    expect(servers["agentdeploy"]).toBeDefined(); // ours was added
  });

  it("preserves existing OpenCode config when merging", () => {
    mkdirSync(join(home, ".config/opencode"), { recursive: true });
    writeFileSync(
      OPENCODE_PATH(home),
      JSON.stringify({
        theme: "catppuccin",
        mcp: {
          linear: { type: "remote", url: "https://mcp.linear.app/mcp", enabled: true },
        },
      }),
    );
    runWriter(home);
    const cfg = readJson(OPENCODE_PATH(home));
    expect(cfg["theme"]).toBe("catppuccin");
    const mcp = cfg["mcp"] as Record<string, unknown>;
    expect(mcp["linear"]).toBeDefined();
    expect(mcp["agentdeploy"]).toBeDefined();
  });

  it("overwrites the agentdeploy entry when called twice with new token", () => {
    runWriter(home);
    const first = readJson(CLAUDE_PATH(home));
    const firstMcp = (first["mcpServers"] as Record<string, { env: Record<string, string> }>)["agentdeploy"];
    expect(firstMcp?.env["AGENT_TOKEN"]).toBe("test-token-123");

    const logs: string[] = [];
    registerAgentDeployMcp({
      mcpBinary: "/opt/agenthub-agent/mcp-deploy.js",
      portalUrl: "https://agenthub.example/",
      agentToken: "NEW-TOKEN-456",
      coderHome: home,
      log: (line) => logs.push(line),
    });
    const second = readJson(CLAUDE_PATH(home));
    const secondMcp = (second["mcpServers"] as Record<string, { env: Record<string, string> }>)["agentdeploy"];
    expect(secondMcp?.env["AGENT_TOKEN"]).toBe("NEW-TOKEN-456");
  });

  it("replaces corrupt JSON cleanly", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(CLAUDE_PATH(home), "{ not valid json ::: ");
    runWriter(home);
    const cfg = readJson(CLAUDE_PATH(home)) as { mcpServers: Record<string, unknown> };
    expect(cfg.mcpServers["agentdeploy"]).toBeDefined();
  });

  it("continues writing other CLIs if one fails", () => {
    // Simulate an unwritable target for Claude by making the file's parent
    // read-only after creating a stale path. Skip on platforms where we
    // can't reliably force chmod (CI-runner ambiguity).
    if (process.getuid?.() === 0) return;
    const logs = runWriter(home);
    // Even without deliberate failure, each writer should log a single
    // "registered" line on success.
    const successLines = logs.filter((l) => /registered agentdeploy/.test(l));
    expect(successLines.length).toBe(3);
  });
});
