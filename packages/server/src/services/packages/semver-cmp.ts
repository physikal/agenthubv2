/**
 * Minimal semver "is a newer than b" check for npm-registry-shaped version
 * strings. We don't pull `semver` as a dep because:
 *   - the version strings we compare are well-behaved (npm "latest" tags)
 *   - we only need "is newer" — not range matching, not coercion, etc.
 *
 * Rules:
 *   - Strip an optional leading `v`.
 *   - Compare major.minor.patch numerically.
 *   - A version without a prerelease sorts after one with a prerelease at
 *     the same major.minor.patch (per semver §11). Prereleases compare
 *     lexicographically — good enough for "rc.1 < rc.2".
 *   - Anything that fails to parse → return false (caller treats as "no
 *     update available", which is the safe default).
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

interface Parsed {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

function parse(input: string): Parsed | null {
  const m = VERSION_RE.exec(input.trim());
  if (!m) return null;
  const [, major, minor, patch, prerelease] = m;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ?? null,
  };
}

export function isNewer(latest: string | null, current: string | null): boolean {
  if (latest === null || current === null) return false;
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;

  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;

  // Same major.minor.patch. A release > a prerelease; otherwise lex compare.
  if (a.prerelease === null && b.prerelease === null) return false;
  if (a.prerelease === null && b.prerelease !== null) return true;
  if (a.prerelease !== null && b.prerelease === null) return false;
  return (a.prerelease ?? "") > (b.prerelease ?? "");
}
