import { describe, expect, it, vi } from "vitest";
import { AuthHandler } from "./handler.js";
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
