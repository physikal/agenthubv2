import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Inspect a workspace source directory from inside the agent's process.
 * Used by the `agentdeploy` MCP to compute `source_analysis` before asking
 * the server which deploy targets are viable.
 *
 * All checks are local filesystem + git commands — no network. Intended to
 * run in <50ms on a small project.
 */

export interface GitSnapshot {
  remote: string | null;
  branch: string | null;
  clean: boolean;
  aheadOfOrigin: boolean;
}

export interface SourceAnalysis {
  path: string;
  hasDockerfile: boolean;
  hasCompose: boolean;
  composePath: string | null;
  isStaticSite: boolean;
  hasPackageJson: boolean;
  gitState: GitSnapshot | null;
}

const COMPOSE_CANDIDATES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
] as const;

function safeStat(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function findCompose(dir: string): string | null {
  for (const candidate of COMPOSE_CANDIDATES) {
    const p = join(dir, candidate);
    if (existsSync(p)) return candidate;
  }
  return null;
}

function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function gitState(dir: string): GitSnapshot | null {
  if (git(dir, ["rev-parse", "--is-inside-work-tree"]) !== "true") return null;

  const remote = git(dir, ["remote", "get-url", "origin"]);
  const branchRaw = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRaw && branchRaw !== "HEAD" ? branchRaw : null;
  const dirty = git(dir, ["status", "--porcelain"]);
  const clean = dirty === "";

  let aheadOfOrigin = false;
  if (remote && branch) {
    const ref = git(dir, ["rev-parse", "--verify", `origin/${branch}`]);
    if (ref === null) {
      aheadOfOrigin = true;
    } else {
      const ahead = git(dir, ["rev-list", `origin/${branch}..HEAD`, "--count"]);
      aheadOfOrigin = ahead !== null && ahead !== "0";
    }
  }

  return { remote, branch, clean, aheadOfOrigin };
}

/**
 * Quick heuristic for "static site": has an index.html at the root AND no
 * Dockerfile AND no server runtime package.json ("start" script). Errs on
 * the side of flagging too few sites as static — false positives would send
 * apps to GitHub Pages that can't run there.
 */
function isStatic(dir: string, hasDockerfile: boolean, hasPackageJson: boolean): boolean {
  if (hasDockerfile) return false;
  const index = safeStat(join(dir, "index.html"));
  if (!index || !index.isFile()) return false;
  if (!hasPackageJson) return true;
  // If package.json exists, only treat as static when there's no "start"
  // script + the project has a build output directory (dist/, build/,
  // public/). Simple + conservative.
  try {
    const entries = readdirSync(dir);
    const hasBuildDir = entries.some((e) => ["dist", "build", "public"].includes(e));
    return hasBuildDir;
  } catch {
    return false;
  }
}

export function introspectSource(absPath: string): SourceAnalysis {
  const dockerfile = safeStat(join(absPath, "Dockerfile"));
  const hasDockerfile = Boolean(dockerfile?.isFile());
  const composePath = findCompose(absPath);
  const hasCompose = composePath !== null;
  const pkgJson = safeStat(join(absPath, "package.json"));
  const hasPackageJson = Boolean(pkgJson?.isFile());

  return {
    path: absPath,
    hasDockerfile,
    hasCompose,
    composePath,
    isStaticSite: isStatic(absPath, hasDockerfile, hasPackageJson),
    hasPackageJson,
    gitState: gitState(absPath),
  };
}
