import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHandler, markClaudeOnboarded } from "./handler.js";
import type { AuthOutbound } from "./protocol.js";

describe("AuthHandler.connect", () => {
  it("spawns the login command and streams stdout lines back", async () => {
    const sent: AuthOutbound[] = [];
    const handler = new AuthHandler({
      send: (msg) => { sent.push(msg); },
      spawn: () => ({
        stdoutLines: (async function* () {
          yield "Visit https://example.com/auth?state=abc to log in";
          yield "Waiting...";
        })(),
        stderrLines: (async function* () {})(),
        kill: vi.fn(),
        wait: () => Promise.resolve(0),
      }),
    });

    await handler.handle({
      type: "auth.connect",
      tool: "claude-code",
      loginCommand: "claude /login",
      urlPattern: "https://example.com/[^\\s]+",
      timeoutSec: 5,
    });

    const lines = sent.filter((m) => m.type === "auth.line");
    expect(lines).toHaveLength(2);
    const first = lines[0];
    expect(first).toBeDefined();
    expect((first as { line: string }).line).toContain("example.com");

    const done = sent.find((m) => m.type === "auth.done");
    expect(done).toBeDefined();
    expect((done as { ok: boolean }).ok).toBe(true);
  });

  it("reports ok=false on non-zero exit", async () => {
    const sent: AuthOutbound[] = [];
    const handler = new AuthHandler({
      send: (msg) => { sent.push(msg); },
      spawn: () => ({
        stdoutLines: (async function* () { yield "error: not authenticated"; })(),
        stderrLines: (async function* () {})(),
        kill: vi.fn(),
        wait: () => Promise.resolve(1),
      }),
    });
    await handler.handle({
      type: "auth.connect",
      tool: "claude-code",
      loginCommand: "claude /login",
      urlPattern: "https://example\\.com/[^\\s]+",
      timeoutSec: 5,
    });
    const done = sent.find((m) => m.type === "auth.done") as { ok: boolean; error?: string };
    expect(done.ok).toBe(false);
    expect(done.error).toMatch(/exit 1/);
  });
});

describe("AuthHandler.disconnect", () => {
  it("runs logoutCommand if provided", async () => {
    const sent: AuthOutbound[] = [];
    const handler = new AuthHandler({
      send: (m) => sent.push(m),
      spawn: () => ({
        stdoutLines: (async function* () {})(),
        stderrLines: (async function* () {})(),
        kill: vi.fn(),
        wait: () => Promise.resolve(0),
      }),
    });
    await handler.handle({
      type: "auth.disconnect",
      tool: "claude-code",
      logoutCommand: "claude /logout",
      credentialPaths: [],
    });
    const done = sent.find((m) => m.type === "auth.disconnected") as { ok: boolean };
    expect(done).toBeDefined();
    expect(done.ok).toBe(true);
  });

  it("deletes credential files when no logoutCommand", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentauth-"));
    const credFile = join(dir, "creds.json");
    writeFileSync(credFile, "{\"x\":1}");
    expect(existsSync(credFile)).toBe(true);

    const sent: AuthOutbound[] = [];
    const handler = new AuthHandler({ send: (m) => sent.push(m) });
    await handler.handle({
      type: "auth.disconnect",
      tool: "test",
      credentialPaths: [credFile],
    });
    expect(existsSync(credFile)).toBe(false);
    const done = sent.find((m) => m.type === "auth.disconnected") as { ok: boolean };
    expect(done).toBeDefined();
    expect(done.ok).toBe(true);
  });
});

describe("AuthHandler.hydrate", () => {
  it("writes hydrate entries to disk with 0600 perms", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentauth-h-"));
    const credFile = join(dir, "subdir", "creds.json");
    const sent: AuthOutbound[] = [];
    const handler = new AuthHandler({ send: (m) => sent.push(m) });

    const contents = Buffer.from("{\"hello\":\"world\"}");
    await handler.handle({
      type: "auth.hydrate",
      entries: [{ tool: "test", path: credFile, contentsBase64: contents.toString("base64") }],
    });

    const { readFileSync, statSync } = await import("node:fs");
    expect(readFileSync(credFile, "utf8")).toBe("{\"hello\":\"world\"}");
    const stat = statSync(credFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("hydrateProbe reports which paths are missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentauth-p-"));
    const present = join(dir, "present.json");
    writeFileSync(present, "x");
    const missing = join(dir, "missing.json");

    const sent: AuthOutbound[] = [];
    const handler = new AuthHandler({ send: (m) => sent.push(m) });
    await handler.handle({
      type: "auth.hydrateProbe",
      tools: [{ tool: "test", paths: [present, missing] }],
    });

    const result = sent.find((m) => m.type === "auth.hydrateProbeResult") as { missing: Array<{ tool: string; path: string }> };
    expect(result).toBeDefined();
    expect(result.missing).toEqual([{ tool: "test", path: missing }]);
  });
});

describe("markClaudeOnboarded", () => {
  let originalHome: string | undefined;
  let home: string;

  beforeEach(() => {
    originalHome = process.env["HOME"];
    home = mkdtempSync(join(tmpdir(), "agentauth-home-"));
    process.env["HOME"] = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
  });

  it("creates .claude.json with the sentinel when missing", async () => {
    await markClaudeOnboarded();
    const parsed = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as Record<string, unknown>;
    expect(parsed["hasCompletedOnboarding"]).toBe(true);
  });

  it("preserves existing .claude.json fields and flips the sentinel", async () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ theme: "dark", oauthAccount: { emailAddress: "user@test" } }),
    );
    await markClaudeOnboarded();
    const parsed = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as Record<string, unknown>;
    expect(parsed["hasCompletedOnboarding"]).toBe(true);
    expect(parsed["theme"]).toBe("dark");
    expect((parsed["oauthAccount"] as { emailAddress: string }).emailAddress).toBe("user@test");
  });

  it("is a no-op when the sentinel is already true", async () => {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "light" }));
    const before = readFileSync(join(home, ".claude.json"), "utf8");
    await markClaudeOnboarded();
    const after = readFileSync(join(home, ".claude.json"), "utf8");
    expect(after).toBe(before);
  });

  it("recovers from a malformed .claude.json by overwriting with sentinel only", async () => {
    writeFileSync(join(home, ".claude.json"), "not valid json {{{");
    await markClaudeOnboarded();
    const parsed = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as Record<string, unknown>;
    expect(parsed["hasCompletedOnboarding"]).toBe(true);
  });
});

describe("AuthHandler claude-code post-auth hook", () => {
  let originalHome: string | undefined;
  let home: string;
  let credPath: string;

  beforeEach(() => {
    originalHome = process.env["HOME"];
    home = mkdtempSync(join(tmpdir(), "agentauth-claude-"));
    process.env["HOME"] = home;
    credPath = join(home, ".claude", ".credentials.json");
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
  });

  it("sets hasCompletedOnboarding after a successful claude-code connect", async () => {
    const handler = new AuthHandler({
      send: () => undefined,
      spawn: () => ({
        stdoutLines: (async function* () {})(),
        stderrLines: (async function* () {})(),
        kill: vi.fn(),
        wait: async () => {
          // Simulate the CLI writing the credential file on its way out.
          const { mkdirSync, writeFileSync } = await import("node:fs");
          mkdirSync(join(home, ".claude"), { recursive: true });
          writeFileSync(credPath, "{\"token\":\"x\"}");
          return 0;
        },
      }),
    });

    await handler.handle({
      type: "auth.connect",
      tool: "claude-code",
      loginCommand: "claude auth login --claudeai",
      urlPattern: "https://",
      timeoutSec: 5,
      credentialPaths: [credPath],
    });

    const claudeJson = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as Record<string, unknown>;
    expect(claudeJson["hasCompletedOnboarding"]).toBe(true);
  });

  it("hydrate path also marks onboarded when claude-code is among entries", async () => {
    const handler = new AuthHandler({ send: () => undefined });
    await handler.handle({
      type: "auth.hydrate",
      entries: [
        { tool: "claude-code", path: credPath, contentsBase64: Buffer.from("{\"token\":\"y\"}").toString("base64") },
      ],
    });

    const claudeJson = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as Record<string, unknown>;
    expect(claudeJson["hasCompletedOnboarding"]).toBe(true);
  });

  it("hydrate path does NOT mark onboarded when only non-claude tools are present", async () => {
    const handler = new AuthHandler({ send: () => undefined });
    const codexPath = join(home, ".codex", "auth.json");
    await handler.handle({
      type: "auth.hydrate",
      entries: [
        { tool: "codex", path: codexPath, contentsBase64: Buffer.from("{}").toString("base64") },
      ],
    });
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
  });
});
