import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { detectContainerPort, formatExecError } from "./local-deploy.js";

describe("detectContainerPort", () => {
  let dir: string;
  let dockerfile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "local-deploy-port-"));
    dockerfile = join(dir, "Dockerfile");
  });

  it("reads an explicit EXPOSE directive", () => {
    writeFileSync(dockerfile, "FROM node:20-alpine\nEXPOSE 8080\nCMD npm start\n");
    expect(detectContainerPort(dockerfile)).toBe(8080);
  });

  it("returns the FIRST EXPOSE when multiple are present", () => {
    writeFileSync(dockerfile, "FROM scratch\nEXPOSE 4000\nEXPOSE 5000\n");
    expect(detectContainerPort(dockerfile)).toBe(4000);
  });

  it("matches EXPOSE case-insensitively and ignores leading whitespace", () => {
    writeFileSync(dockerfile, "FROM scratch\n  expose 9000\n");
    expect(detectContainerPort(dockerfile)).toBe(9000);
  });

  it("defaults nginx-based images without EXPOSE to port 80", () => {
    writeFileSync(dockerfile, "FROM nginx:alpine\nCOPY index.html /usr/share/nginx/html/\n");
    expect(detectContainerPort(dockerfile)).toBe(80);
  });

  it("defaults httpd to port 80", () => {
    writeFileSync(dockerfile, "FROM httpd:2.4\n");
    expect(detectContainerPort(dockerfile)).toBe(80);
  });

  it("defaults caddy to port 80", () => {
    writeFileSync(dockerfile, "FROM caddy:2-alpine\n");
    expect(detectContainerPort(dockerfile)).toBe(80);
  });

  it("falls back to 3000 for unknown FROM images without EXPOSE", () => {
    writeFileSync(dockerfile, "FROM node:20-alpine\nCMD npm start\n");
    expect(detectContainerPort(dockerfile)).toBe(3000);
  });

  it("falls back to 3000 when Dockerfile is missing", () => {
    expect(detectContainerPort(join(dir, "missing-Dockerfile"))).toBe(3000);
  });

  it("ignores EXPOSE values that are out of range", () => {
    writeFileSync(dockerfile, "FROM scratch\nEXPOSE 99999\n");
    // Out-of-range falls through; no FROM hint either, so default 3000.
    expect(detectContainerPort(dockerfile)).toBe(3000);
  });

  it("EXPOSE wins even when FROM would suggest 80", () => {
    // User explicitly running nginx on a non-default port — respect their
    // EXPOSE, don't second-guess it.
    writeFileSync(dockerfile, "FROM nginx:alpine\nEXPOSE 8000\n");
    expect(detectContainerPort(dockerfile)).toBe(8000);
  });
});

describe("formatExecError", () => {
  it("prefers stderr (the real docker compose error) over the bare message", () => {
    const err = {
      message: "Command failed: docker compose -p x up -d --build",
      stderr: 'Error response from daemon: driver failed: Bind for 0.0.0.0:80 failed: port is already allocated',
    };
    expect(formatExecError(err)).toContain("port is already allocated");
  });

  it("falls back to message when stderr is empty", () => {
    expect(formatExecError({ message: "boom", stderr: "  " })).toBe("boom");
  });

  it("handles non-Error throwables", () => {
    expect(formatExecError("plain string")).toBe("plain string");
  });

  it("keeps the TAIL when output exceeds the cap (failure reason is last)", () => {
    const tail = "FATAL: the actual error line";
    const big = "build log line\n".repeat(1000) + tail;
    const out = formatExecError({ stderr: big });
    expect(out.length).toBeLessThanOrEqual(4001); // 4000 + leading ellipsis
    expect(out.startsWith("…")).toBe(true);
    expect(out).toContain(tail);
  });
});
