import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { introspectGitRepo } from "./git-introspect.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "agenthub-git-introspect-"));
}

describe("introspectGitRepo", () => {
  let repoDir: string;
  let remoteDir: string;

  beforeEach(() => {
    // Bare remote to act as "origin"
    remoteDir = makeTmpDir();
    git(remoteDir, "init", "--bare", "-b", "main");

    // Working repo with the bare as origin
    repoDir = makeTmpDir();
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.email", "test@example.com");
    git(repoDir, "config", "user.name", "Test User");
    git(repoDir, "config", "commit.gpgsign", "false");
    git(repoDir, "remote", "add", "origin", remoteDir);
    writeFileSync(join(repoDir, "README.md"), "# test\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "init");
    git(repoDir, "push", "origin", "main");
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  });

  it("returns ok for a clean pushed repo", () => {
    const r = introspectGitRepo(repoDir);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.branch).toBe("main");
    expect(r.remote).toBe(remoteDir);
  });

  it("errors when path is not a git repo", () => {
    const nonRepo = makeTmpDir();
    try {
      const r = introspectGitRepo(nonRepo);
      expect(r.kind).toBe("error");
      if (r.kind !== "error") return;
      expect(r.code).toBe("not-a-repo");
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it("errors when origin remote is missing", () => {
    git(repoDir, "remote", "remove", "origin");
    const r = introspectGitRepo(repoDir);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.code).toBe("no-remote");
  });

  it("errors when working tree is dirty", () => {
    writeFileSync(join(repoDir, "dirty.txt"), "local change\n");
    const r = introspectGitRepo(repoDir);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.code).toBe("dirty");
  });

  it("errors when HEAD is ahead of origin", () => {
    writeFileSync(join(repoDir, "next.txt"), "new\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "next");
    const r = introspectGitRepo(repoDir);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.code).toBe("ahead-of-origin");
  });

  it("normalizes ssh-style remotes to https", () => {
    // `remote set-url` changes the URL returned by `git remote get-url` but
    // does NOT invalidate the already-cached `refs/remotes/origin/main` from
    // the earlier push, so rev-parse origin/main still resolves and we hit
    // the ok branch.
    git(repoDir, "remote", "set-url", "origin", "git@github.com:owner/repo.git");
    const r = introspectGitRepo(repoDir);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.remote).toBe("https://github.com/owner/repo.git");
  });
});
