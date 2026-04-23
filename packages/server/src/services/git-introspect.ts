import { execFileSync } from "node:child_process";

export type GitIntrospection =
  | {
      readonly kind: "ok";
      /** HTTPS-normalized remote URL for `origin`. */
      readonly remote: string;
      /** Current branch name (from `rev-parse --abbrev-ref HEAD`). */
      readonly branch: string;
    }
  | {
      readonly kind: "error";
      readonly code:
        | "not-a-repo"
        | "no-remote"
        | "dirty"
        | "ahead-of-origin"
        | "detached-head";
      readonly message: string;
    };

const TIMEOUT_MS = 2_000;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    timeout: TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Normalize `git@host:owner/repo(.git)` SSH URLs to `https://host/owner/repo(.git)`
 * so Dokploy / DO App Platform / GH Pages can clone without SSH keys.
 * Leaves https://, http://, and anything unrecognized untouched.
 */
function normalizeRemote(url: string): string {
  const m = /^git@([^:]+):(.+)$/.exec(url);
  if (!m) return url;
  return `https://${m[1]}/${m[2]}`;
}

/**
 * Inspect a working directory to determine whether it's safe to deploy via a
 * git-pull provider (Dokploy, DO App Platform, GH Pages). All errors are
 * returned as discriminated-union variants so callers can map to actionable
 * messages without try/catch.
 */
export function introspectGitRepo(absPath: string): GitIntrospection {
  let isWorkTree: string;
  try {
    isWorkTree = git(absPath, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return {
      kind: "error",
      code: "not-a-repo",
      message: `${absPath} is not a git repository`,
    };
  }
  if (isWorkTree !== "true") {
    return {
      kind: "error",
      code: "not-a-repo",
      message: `${absPath} is not inside a git work tree`,
    };
  }

  let remote: string;
  try {
    remote = normalizeRemote(git(absPath, ["remote", "get-url", "origin"]));
  } catch {
    return {
      kind: "error",
      code: "no-remote",
      message: `${absPath} has no 'origin' remote — push to GitHub first (e.g. 'gh repo create --source=. --push')`,
    };
  }

  const branch = git(absPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD") {
    return {
      kind: "error",
      code: "detached-head",
      message: `${absPath} is in detached-HEAD state; check out a branch before deploying`,
    };
  }

  const dirty = git(absPath, ["status", "--porcelain"]);
  if (dirty.length > 0) {
    return {
      kind: "error",
      code: "dirty",
      message: `${absPath} has uncommitted changes — commit and push before deploying`,
    };
  }

  // If origin/<branch> doesn't resolve, treat as ahead-of-origin with a
  // pointer at the fix.
  try {
    git(absPath, ["rev-parse", "--verify", `origin/${branch}`]);
  } catch {
    return {
      kind: "error",
      code: "ahead-of-origin",
      message: `origin/${branch} does not exist — push this branch to origin first`,
    };
  }

  const aheadCount = git(absPath, [
    "rev-list",
    `origin/${branch}..HEAD`,
    "--count",
  ]);
  if (aheadCount !== "0") {
    return {
      kind: "error",
      code: "ahead-of-origin",
      message: `${absPath} has ${aheadCount} commit(s) not pushed to origin/${branch}`,
    };
  }

  return { kind: "ok", remote, branch };
}
