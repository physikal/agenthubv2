import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeStagingManifest, packBundle } from "./bundler.js";
import { BUNDLE_SCHEMA_VERSION } from "./types.js";

describe("writeStagingManifest", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "bundler-test-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("writes a valid manifest.json", () => {
    writeStagingManifest(tmp, {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      createdAt: "2026-05-13T00:00:00.000Z",
      sourceDomain: "agenthub.example.com",
      gitSha: "abc",
      composeVersion: "v2",
      trigger: "manual",
    });
    const json = readFileSync(join(tmp, "manifest.json"), "utf8");
    expect(JSON.parse(json).sourceDomain).toBe("agenthub.example.com");
  });
});

describe("packBundle", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "bundler-test-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("tars + gzips a staging dir into the output path", async () => {
    // Set up staging with fixture files
    writeFileSync(join(tmp, "env"), "DOMAIN=agenthub.example.com\n");
    writeFileSync(join(tmp, "agenthub.db"), Buffer.from([1, 2, 3]));
    writeFileSync(join(tmp, "infisical.sql"), Buffer.from([4, 5, 6]));
    writeFileSync(join(tmp, "manifest.json"), '{"schemaVersion":1}');

    const outPath = join(tmp, "..", "out.tar.gz");
    await packBundle(tmp, outPath);

    expect(existsSync(outPath)).toBe(true);
    expect(statSync(outPath).size).toBeGreaterThan(0);
    rmSync(outPath);
  });
});
