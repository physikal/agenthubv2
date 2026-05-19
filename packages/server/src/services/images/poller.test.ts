import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { db, schema, initDb } from "../../db/index.js";
import { ImagePoller } from "./poller.js";
import { EnvOverrides } from "./env-overrides.js";
import type { RegistryClient } from "./registry-client.js";

beforeAll(() => { initDb(); });

class FakeRegistry implements RegistryClient {
  constructor(
    private readonly tagsByRepo: Record<string, readonly string[]>,
    private readonly digestByTag: Record<string, string> = {},
    private readonly errorRepos: ReadonlySet<string> = new Set(),
  ) {}
  async listTags(repo: string): Promise<readonly string[]> {
    if (this.errorRepos.has(repo)) throw new Error(`forced failure for ${repo}`);
    return this.tagsByRepo[repo] ?? [];
  }
  async getDigest(repo: string, tag: string): Promise<string> {
    if (this.errorRepos.has(repo)) throw new Error(`forced failure for ${repo}`);
    return this.digestByTag[`${repo}:${tag}`] ?? "sha256:deadbeef";
  }
}

describe("ImagePoller.tick", () => {
  let dir: string;
  let env: EnvOverrides;

  beforeEach(() => {
    db.delete(schema.imageVersionCache).run();
    dir = mkdtempSync(join(tmpdir(), "imgpoll-"));
    writeFileSync(join(dir, ".env"), "");
    env = new EnvOverrides({ envPath: join(dir, ".env") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("upserts a row per image with newest within/across major filled in", async () => {
    const registry = new FakeRegistry({
      traefik: ["v3.6", "v3.7.1", "v3.7.2", "v4.0.0"],
      postgres: ["16-alpine", "16.4-alpine", "17-alpine"],
      redis: ["7-alpine", "7.2-alpine", "8-alpine"],
      "infisical/infisical": [],
    }, { "infisical/infisical:latest-postgres": "sha256:abc123" });

    const poller = new ImagePoller(env, registry);
    await poller.tick();

    const rows = db.select().from(schema.imageVersionCache).all();
    expect(rows.map((r) => r.image).sort()).toEqual(["infisical", "postgres", "redis", "traefik"]);
    const traefik = rows.find((r) => r.image === "traefik");
    expect(traefik?.newestWithinMajor).toBe("v3.7.2");
    expect(traefik?.newestAcrossMajor).toBe("v4.0.0");
    expect(traefik?.lastError).toBeNull();
    const pg = rows.find((r) => r.image === "postgres");
    expect(pg?.newestWithinMajor).toBe("16.4-alpine");
    expect(pg?.newestAcrossMajor).toBe("17-alpine");
    const inf = rows.find((r) => r.image === "infisical");
    expect(inf?.upstreamDigest).toBe("sha256:abc123");
    expect(inf?.newestWithinMajor).toBeNull();
  });

  it("isolates per-image failures — one failing image doesn't poison the others", async () => {
    const registry = new FakeRegistry(
      { traefik: ["v3.7"], postgres: ["16-alpine"], redis: ["7-alpine"], "infisical/infisical": [] },
      { "infisical/infisical:latest-postgres": "sha256:xyz" },
      new Set(["traefik"]),
    );
    const poller = new ImagePoller(env, registry);
    await poller.tick();
    const rows = db.select().from(schema.imageVersionCache).all();
    const traefik = rows.find((r) => r.image === "traefik");
    expect(traefik?.lastError).toContain("forced failure");
    const pg = rows.find((r) => r.image === "postgres");
    expect(pg?.lastError).toBeNull();
  });

  it("clears lastError on a subsequent successful tick", async () => {
    const failing = new FakeRegistry(
      { traefik: [], postgres: [], redis: [], "infisical/infisical": [] },
      {},
      new Set(["traefik"]),
    );
    await new ImagePoller(env, failing).tick();
    let traefik = db.select().from(schema.imageVersionCache).all().find((r) => r.image === "traefik");
    expect(traefik?.lastError).toBeTruthy();

    const succeeding = new FakeRegistry(
      { traefik: ["v3.6", "v3.7"], postgres: [], redis: [], "infisical/infisical": [] },
      { "infisical/infisical:latest-postgres": "sha256:x" },
    );
    await new ImagePoller(env, succeeding).tick();
    traefik = db.select().from(schema.imageVersionCache).all().find((r) => r.image === "traefik");
    expect(traefik?.lastError).toBeNull();
    expect(traefik?.newestWithinMajor).toBe("v3.7");
  });
});
