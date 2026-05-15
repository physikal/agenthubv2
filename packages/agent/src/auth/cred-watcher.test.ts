import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialWatcher } from "./cred-watcher.js";
import type { AuthOutbound } from "./protocol.js";

describe("CredentialWatcher", () => {
  it("emits auth.captured when a watched path is written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "credw-"));
    const target = join(dir, "creds.json");
    const sent: AuthOutbound[] = [];
    const watcher = new CredentialWatcher({
      send: (m) => sent.push(m),
      debounceMs: 30,
      tools: [{ tool: "test", paths: [target] }],
    });
    watcher.start();
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(target, '{"a":1}');
    await new Promise((r) => setTimeout(r, 120));
    watcher.stop();

    const captured = sent.find((m) => m.type === "auth.captured") as {
      tool: string;
      path: string;
      contentsBase64: string;
    };
    expect(captured).toBeDefined();
    expect(captured.tool).toBe("test");
    expect(captured.path).toBe(target);
    expect(Buffer.from(captured.contentsBase64, "base64").toString()).toBe('{"a":1}');
  });
});
