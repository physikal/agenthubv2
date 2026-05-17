import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema, initDb } from "../../db/index.js";
import { VersionPoller } from "./poller.js";

// Server tests run against an in-memory SQLite (test/setup.ts sets
// DB_PATH=:memory:). The singleton in db/index.ts is created on first
// import, but its tables only exist after initDb() runs. Call it once
// here so the package_version_cache table exists before any test.
beforeAll(() => {
  initDb();
});

describe("VersionPoller.tick", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.delete(schema.packageVersionCache).run();
  });

  beforeEach(() => {
    db.delete(schema.packageVersionCache).run();
  });

  it("upserts a success row for each npm-method catalog entry", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      // Return a deterministic version derived from the package slug so each
      // upsert is distinguishable.
      const slug = decodeURIComponent(url.split("/").slice(-2, -1)[0] ?? "");
      return new Response(JSON.stringify({ version: `1.${slug.length}.0` }), { status: 200 });
    }) as typeof fetch;

    const poller = new VersionPoller();
    await poller.tick();

    const rows = db.select().from(schema.packageVersionCache).all();
    // claude-code, opencode, minimax, codex are npm; droid is curl-sh.
    const ids = rows.map((r) => r.packageId).sort();
    expect(ids).toEqual(["claude-code", "codex", "droid", "minimax", "opencode"]);
    const claude = rows.find((r) => r.packageId === "claude-code");
    expect(claude?.latestVersion).toMatch(/^1\.\d+\.0$/);
    expect(claude?.error).toBeNull();
  });

  it("records an error row when fetch fails, preserving last-good version", async () => {
    db.insert(schema.packageVersionCache).values({
      packageId: "claude-code",
      latestVersion: "1.0.42",
      checkedAt: new Date(Date.now() - 60_000),
      error: null,
    }).run();

    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network unreachable")) as typeof fetch;
    const poller = new VersionPoller();
    await poller.tick();

    const row = db.select().from(schema.packageVersionCache)
      .where(eq(schema.packageVersionCache.packageId, "claude-code"))
      .get();
    expect(row?.error).toMatch(/network unreachable/);
    // Last-good version preserved.
    expect(row?.latestVersion).toBe("1.0.42");
  });

  it("clears a previously-stored error on a subsequent success", async () => {
    db.insert(schema.packageVersionCache).values({
      packageId: "claude-code",
      latestVersion: null,
      checkedAt: new Date(Date.now() - 60_000),
      error: "stale failure",
    }).run();

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: "1.0.50" }), { status: 200 }),
    ) as typeof fetch;
    const poller = new VersionPoller();
    await poller.tick();

    const row = db.select().from(schema.packageVersionCache)
      .where(eq(schema.packageVersionCache.packageId, "claude-code"))
      .get();
    expect(row?.error).toBeNull();
    expect(row?.latestVersion).toBe("1.0.50");
  });
});

describe("VersionPoller.start / stop", () => {
  it("ticks once immediately and schedules an interval", async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 }),
      ) as typeof fetch;
      const poller = new VersionPoller(60_000);
      const tickSpy = vi.spyOn(poller, "tick");
      poller.start();
      // start() fires an immediate tick (void).
      expect(tickSpy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      expect(tickSpy).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(60_000);
      expect(tickSpy).toHaveBeenCalledTimes(3);
      poller.stop();
      vi.advanceTimersByTime(60_000);
      expect(tickSpy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
