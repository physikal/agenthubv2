import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { db, schema, initDb } from "../../db/index.js";
import { ImagesManager, composeFileFlags } from "./manager.js";
import { EnvOverrides } from "./env-overrides.js";

beforeAll(() => { initDb(); });

describe("composeFileFlags", () => {
  const saved = {
    dir: process.env["AGENTHUB_COMPOSE_DIR"],
    files: process.env["AGENTHUB_COMPOSE_FILES"],
  };
  afterEach(() => {
    if (saved.dir === undefined) delete process.env["AGENTHUB_COMPOSE_DIR"];
    else process.env["AGENTHUB_COMPOSE_DIR"] = saved.dir;
    if (saved.files === undefined) delete process.env["AGENTHUB_COMPOSE_FILES"];
    else process.env["AGENTHUB_COMPOSE_FILES"] = saved.files;
  });

  it("lan (single file): one -f against the compose dir", () => {
    process.env["AGENTHUB_COMPOSE_DIR"] = "/repo/compose";
    process.env["AGENTHUB_COMPOSE_FILES"] = "docker-compose.yml";
    expect(composeFileFlags()).toEqual(["-f", "/repo/compose/docker-compose.yml"]);
  });

  it("public (override): one -f per colon-separated file, in order", () => {
    process.env["AGENTHUB_COMPOSE_DIR"] = "/repo/compose";
    process.env["AGENTHUB_COMPOSE_FILES"] = "docker-compose.yml:traefik.override.yml";
    expect(composeFileFlags()).toEqual([
      "-f", "/repo/compose/docker-compose.yml",
      "-f", "/repo/compose/traefik.override.yml",
    ]);
  });

  it("dev fallback when env unset: relative compose/docker-compose.yml", () => {
    delete process.env["AGENTHUB_COMPOSE_DIR"];
    delete process.env["AGENTHUB_COMPOSE_FILES"];
    expect(composeFileFlags()).toEqual(["-f", "compose/docker-compose.yml"]);
  });
});

describe("ImagesManager.getUpdatesSummary", () => {
  let dir: string;
  let env: EnvOverrides;

  beforeEach(() => {
    db.delete(schema.imageVersionCache).run();
    dir = mkdtempSync(join(tmpdir(), "imgmgr-"));
    writeFileSync(join(dir, ".env"), "");
    env = new EnvOverrides({ envPath: join(dir, ".env") });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns one row per catalog image, marking updateAvailable", async () => {
    db.insert(schema.imageVersionCache).values({
      image: "traefik", pinnedTag: "traefik:v3.6",
      newestWithinMajor: "v3.7.1", newestAcrossMajor: "v4.0",
      upstreamDigest: null, lastCheckedAt: new Date(), lastError: null,
    }).run();
    const mgr = new ImagesManager(env, () => Promise.resolve("sha256:current"));
    const summary = await mgr.getUpdatesSummary();
    expect(summary.images).toHaveLength(4);
    const traefik = summary.images.find((r) => r.image === "traefik");
    expect(traefik?.updateAvailable).toBe(true);
    expect(traefik?.newestWithinMajor).toBe("v3.7.1");
    expect(traefik?.newestAcrossMajor).toBe("v4.0");
    // Images without a cache row yet still appear, with null upstream fields
    const pg = summary.images.find((r) => r.image === "postgres");
    expect(pg?.updateAvailable).toBe(false);
    expect(pg?.newestWithinMajor).toBeNull();
  });
});

describe("ImagesManager.validateApply", () => {
  let env: EnvOverrides;
  let dir: string;
  beforeEach(() => {
    db.delete(schema.imageVersionCache).run();
    dir = mkdtempSync(join(tmpdir(), "imgmgr-"));
    writeFileSync(join(dir, ".env"), "");
    env = new EnvOverrides({ envPath: join(dir, ".env") });
    db.insert(schema.imageVersionCache).values({
      image: "traefik", pinnedTag: "traefik:v3.6",
      newestWithinMajor: "v3.7.1", newestAcrossMajor: "v4.0",
      upstreamDigest: null, lastCheckedAt: new Date(), lastError: null,
    }).run();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("accepts a within-major tag", () => {
    const mgr = new ImagesManager(env, () => Promise.resolve(""));
    expect(() => mgr.validateApply({ image: "traefik", tag: "v3.7.1" })).not.toThrow();
  });

  it("rejects major bump without acknowledgedMajor", () => {
    const mgr = new ImagesManager(env, () => Promise.resolve(""));
    expect(() => mgr.validateApply({ image: "traefik", tag: "v4.0" }))
      .toThrow(/acknowledgedMajor/);
  });

  it("accepts major bump with acknowledgedMajor", () => {
    const mgr = new ImagesManager(env, () => Promise.resolve(""));
    expect(() => mgr.validateApply({ image: "traefik", tag: "v4.0", acknowledgedMajor: true }))
      .not.toThrow();
  });

  it("rejects an arbitrary tag not in the cache", () => {
    const mgr = new ImagesManager(env, () => Promise.resolve(""));
    expect(() => mgr.validateApply({ image: "traefik", tag: "v9.9.9" })).toThrow();
  });
});
