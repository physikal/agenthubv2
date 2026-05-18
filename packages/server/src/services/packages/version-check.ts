import type { InstallSpec } from "./catalog.js";

export type VersionCheckResult =
  | { latest: string }
  | { error: string };

/**
 * Resolve the upstream "latest" version for a given install spec.
 *
 * npm           → registry.npmjs.org/<pkg>/latest
 * curl-sh       → no reliable upstream version source (script content
 *                 carries no semver) — caller treats as "unknown"
 * binary        → same as curl-sh; reserved for future github-release
 *                 dispatch if/when we add tools with GH-release installers
 */
export async function checkVersion(spec: InstallSpec): Promise<VersionCheckResult> {
  if (spec.method === "npm") return checkNpm(spec.npmPackage);
  return { error: `no version source for install method ${spec.method}` };
}

async function checkNpm(pkg: string): Promise<VersionCheckResult> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { error: `npm ${pkg}: HTTP ${String(res.status)}` };
    const body = (await res.json()) as { version?: string };
    if (!body.version) return { error: `npm ${pkg}: no version in response` };
    return { latest: body.version };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `npm ${pkg}: ${msg}` };
  }
}
