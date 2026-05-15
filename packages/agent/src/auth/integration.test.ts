import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthHandler } from "./handler.js";
import { CredentialWatcher } from "./cred-watcher.js";
import type { AuthOutbound } from "./protocol.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("daemon auth integration", () => {
  it("running fake-claude.sh produces auth.captured event via the watcher", async () => {
    const home = mkdtempSync(join(tmpdir(), "fakehome-"));
    const credPath = join(home, ".claude", ".credentials.json");
    const fakeCli = resolve(
      here,
      "../../../server/test/fixtures/fake-cli/fake-claude.sh",
    );

    const events: AuthOutbound[] = [];
    const send = (m: AuthOutbound): void => {
      events.push(m);
    };

    const handler = new AuthHandler({ send });
    const watcher = new CredentialWatcher({
      send,
      debounceMs: 30,
      tools: [{ tool: "claude-code", paths: [credPath] }],
    });
    watcher.start();
    // Give the watcher a tick to install the fs.watch listener.
    await new Promise((r) => setTimeout(r, 30));

    await handler.handle({
      type: "auth.connect",
      tool: "claude-code",
      loginCommand: `HOME=${home} sh ${fakeCli}`,
      urlPattern: "https://claude\\.ai/oauth/[^\\s]+",
      timeoutSec: 5,
    });

    // Wait past the watcher debounce.
    await new Promise((r) => setTimeout(r, 200));
    watcher.stop();

    const captured = events.find((e) => e.type === "auth.captured");
    expect(captured).toBeDefined();
    expect((captured as { tool: string }).tool).toBe("claude-code");

    const lines = events.filter((e) => e.type === "auth.line");
    const urlSeen = lines.some(
      (l) => (l as { line: string }).line.includes("claude.ai/oauth"),
    );
    expect(urlSeen).toBe(true);

    const done = events.find((e) => e.type === "auth.done") as { ok: boolean };
    expect(done.ok).toBe(true);
  });
});
