import type { ImageKey } from "./types.js";

export interface SemverParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
  readonly variant: string | undefined;
}

export type PinPolicy =
  | {
      readonly mode: "semver";
      readonly matcher: RegExp;
      readonly extract: (m: RegExpMatchArray) => SemverParts;
    }
  | { readonly mode: "digest" };

const traefikMatcher = /^v(\d+)\.(\d+)(?:\.(\d+))?$/;
const pgRedisMatcher = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(-alpine)?$/;

export const PIN_POLICY: Record<ImageKey, PinPolicy> = {
  traefik: {
    mode: "semver",
    matcher: traefikMatcher,
    extract: (m) => ({
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: m[3] ? Number(m[3]) : 0,
      raw: m[0],
      variant: undefined,
    }),
  },
  postgres: {
    mode: "semver",
    matcher: pgRedisMatcher,
    extract: (m) => ({
      major: Number(m[1]),
      minor: m[2] ? Number(m[2]) : 0,
      patch: m[3] ? Number(m[3]) : 0,
      raw: m[0],
      variant: m[4] ?? undefined,
    }),
  },
  redis: {
    mode: "semver",
    matcher: pgRedisMatcher,
    extract: (m) => ({
      major: Number(m[1]),
      minor: m[2] ? Number(m[2]) : 0,
      patch: m[3] ? Number(m[3]) : 0,
      raw: m[0],
      variant: m[4] ?? undefined,
    }),
  },
  infisical: { mode: "digest" },
};

/** Returns `'unknown'` if the tag doesn't match the policy regex. */
export function classify(tag: string, policy: PinPolicy): SemverParts | "unknown" {
  if (policy.mode === "digest") return "unknown";
  const m = tag.match(policy.matcher);
  if (!m) return "unknown";
  return policy.extract(m);
}

function cmp(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Newest tag within the pinned major, preserving variant stickiness.
 * If `pinned` is provided, the result must be strictly newer than it.
 */
export function newestWithinMajor(
  tags: readonly SemverParts[],
  pinnedMajor: number,
  variant: string | undefined,
  pinned?: SemverParts,
): SemverParts | null {
  const inMajor = tags.filter((t) => t.major === pinnedMajor && t.variant === variant);
  if (inMajor.length === 0) return null;
  const newest = inMajor.reduce((best, cur) => (cmp(cur, best) > 0 ? cur : best));
  if (pinned && cmp(newest, pinned) <= 0) return null;
  return newest;
}

export function newestAcrossMajor(
  tags: readonly SemverParts[],
  pinnedMajor: number,
): SemverParts | null {
  const above = tags.filter((t) => t.major > pinnedMajor);
  if (above.length === 0) return null;
  return above.reduce((best, cur) => (cmp(cur, best) > 0 ? cur : best));
}

export function parsePinnedRef(ref: string): { readonly image: string; readonly tag: string } {
  const idx = ref.lastIndexOf(":");
  // Guard against scheme-looking strings; only treat the last `:`-segment as
  // a tag if it doesn't contain `/` (registry hosts use `host:port/image`).
  if (idx === -1 || ref.slice(idx).includes("/")) {
    return { image: ref, tag: "latest" };
  }
  return { image: ref.slice(0, idx), tag: ref.slice(idx + 1) };
}
