import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { db, schema, initDb } from "../db/index.js";
import { adminUpdatesRoutes } from "./admin-updates.js";
import { releaseUpdateLock, tryAcquireUpdateLock } from "../services/update-lock.js";
import { EnvOverrides } from "../services/images/env-overrides.js";

beforeAll(() => { initDb(); });

function makeApp(envPath: string) {
  const env = new EnvOverrides({ envPath });
  const root = new Hono();
  root.route(
    "/api/admin/updates",
    adminUpdatesRoutes({ env, runningDigest: () => Promise.resolve(null) }),
  );
  return root;
}

describe("GET /api/admin/updates", () => {
  let dir: string;
  beforeEach(() => {
    db.delete(schema.imageVersionCache).run();
    dir = mkdtempSync(join(tmpdir(), "ar-"));
    writeFileSync(join(dir, ".env"), "");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns one row per image", async () => {
    const app = makeApp(join(dir, ".env"));
    const res = await app.request("/api/admin/updates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { images: unknown[] };
    expect(body.images).toHaveLength(4);
  });
});

describe("POST /api/admin/updates/image", () => {
  let dir: string;
  beforeEach(() => {
    db.delete(schema.imageVersionCache).run();
    dir = mkdtempSync(join(tmpdir(), "ar-"));
    writeFileSync(join(dir, ".env"), "");
    releaseUpdateLock();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns 409 when another update holds the lock", async () => {
    tryAcquireUpdateLock("agenthub");
    const app = makeApp(join(dir, ".env"));
    const res = await app.request("/api/admin/updates/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: "traefik", tag: "v3.7" }),
    });
    expect(res.status).toBe(409);
    releaseUpdateLock();
  });

  it("returns 400 for a major bump without acknowledgedMajor", async () => {
    db.insert(schema.imageVersionCache).values({
      image: "traefik", pinnedTag: "traefik:v3.6",
      newestWithinMajor: "v3.7.1", newestAcrossMajor: "v4.0",
      upstreamDigest: null, lastCheckedAt: new Date(), lastError: null,
    }).run();
    const app = makeApp(join(dir, ".env"));
    const res = await app.request("/api/admin/updates/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: "traefik", tag: "v4.0" }),
    });
    expect(res.status).toBe(400);
  });
});
