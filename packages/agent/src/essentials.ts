import { access } from "node:fs/promises";
import { installPackage, LOCAL_BIN, type PackageOpResult } from "./package-ops.js";
import type { EssentialSpec } from "./packages-protocol.js";

export interface EnsureEssentialsDeps {
  binExists: (binName: string) => Promise<boolean>;
  install: (spec: EssentialSpec) => Promise<PackageOpResult>;
  /** Wired to the WS-out send by the caller so install progress reaches the session terminal. */
  log: (line: string) => void;
}

export interface EnsureEssentialsResult {
  installed: string[];
  skipped: string[];
  failed: string[];
}

const defaultDeps: EnsureEssentialsDeps = {
  binExists: defaultBinExists,
  install: (spec) =>
    installPackage({
      packageId: spec.packageId,
      binName: spec.binName,
      versionCmd: spec.versionCmd,
      spec: spec.install,
    }),
  log: () => undefined,
};

async function defaultBinExists(binName: string): Promise<boolean> {
  try {
    await access(`${LOCAL_BIN}/${binName}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * For each essential, if its binary is missing from /home/coder/.local/bin,
 * install it. Runs installs in parallel — a single npm install is mostly
 * I/O-bound and the workspace has spare CPU. Per-package failures are
 * collected and do not abort siblings.
 *
 * Idempotent: running twice in succession is cheap (just stat() calls).
 */
export async function ensureEssentials(
  specs: readonly EssentialSpec[],
  depsOverride: Partial<EnsureEssentialsDeps> = {},
): Promise<EnsureEssentialsResult> {
  const deps: EnsureEssentialsDeps = { ...defaultDeps, ...depsOverride };
  const skipped: string[] = [];
  const missing: EssentialSpec[] = [];

  for (const s of specs) {
    if (await deps.binExists(s.binName)) {
      skipped.push(s.packageId);
    } else {
      missing.push(s);
    }
  }

  if (missing.length === 0) {
    return { installed: [], skipped, failed: [] };
  }

  deps.log(`[essentials] installing: ${missing.map((m) => m.packageId).join(", ")}`);

  const installed: string[] = [];
  const failed: string[] = [];

  await Promise.all(
    missing.map(async (s) => {
      try {
        const result = await deps.install(s);
        if (result.ok) {
          installed.push(s.packageId);
          deps.log(`[essentials] ${s.packageId} installed${result.version ? ` (${result.version})` : ""}`);
        } else {
          failed.push(s.packageId);
          deps.log(`[essentials] ${s.packageId} failed: ${result.error ?? "unknown error"}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failed.push(s.packageId);
        deps.log(`[essentials] ${s.packageId} failed: ${msg}`);
      }
    }),
  );

  return { installed, skipped, failed };
}
