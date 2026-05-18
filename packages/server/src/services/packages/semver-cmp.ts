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
 *     the same major.minor.patch (per semver §11).
 *   - Prereleases compare per semver §11.4: numeric identifiers
 *     numerically, alphanumeric lexicographically, numeric always
 *     lower-precedence than alphanumeric, longer wins on tied prefix.
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
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ?? null,
  };
}

function comparePrerelease(a: string, b: string): number {
  const aParts = a.split(".");
  const bParts = b.split(".");
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ai = aParts[i];
    const bi = bParts[i];
    // Per semver §11.4.4: longer prerelease wins when prefixes match.
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aIsNum = /^\d+$/.test(ai);
    const bIsNum = /^\d+$/.test(bi);
    if (aIsNum && bIsNum) {
      const an = Number(ai);
      const bn = Number(bi);
      if (an !== bn) return an > bn ? 1 : -1;
    } else if (aIsNum && !bIsNum) {
      // §11.4.3: numeric identifiers always have lower precedence than alphanumeric.
      return -1;
    } else if (!aIsNum && bIsNum) {
      return 1;
    } else if (ai !== bi) {
      return ai > bi ? 1 : -1;
    }
  }
  return 0;
}

export function isNewer(latest: string | null, current: string | null): boolean {
  if (latest === null || current === null) return false;
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;

  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;

  // Same major.minor.patch. A release > a prerelease; otherwise §11.4 compare.
  if (a.prerelease === null && b.prerelease === null) return false;
  if (a.prerelease === null && b.prerelease !== null) return true;
  if (a.prerelease !== null && b.prerelease === null) return false;
  if (a.prerelease !== null && b.prerelease !== null) {
    return comparePrerelease(a.prerelease, b.prerelease) > 0;
  }
  return false;
}
