import { access } from "node:fs/promises";
import { installPackage, LOCAL_BIN, readVersion, type PackageOpResult } from "./package-ops.js";
import type { EssentialSpec } from "./packages-protocol.js";

/** One-shot outcome emitted per package via the {@link EnsureEssentialsDeps.onResult} callback. */
export interface EssentialResult {
  packageId: string;
  ok: boolean;
  version?: string;
  error?: string;
}

export interface EnsureEssentialsDeps {
  binExists: (binName: string) => Promise<boolean>;
  install: (spec: EssentialSpec) => Promise<PackageOpResult>;
  /**
   * Reads the current version for an already-installed binary. Used for the
   * skip path so the server gets a version even when no install ran.
   */
  readVersion: (spec: EssentialSpec) => Promise<string | null>;
  /** Wired to the WS-out send by the caller so install progress reaches the session terminal. */
  log: (line: string) => void;
  /**
   * Fired once per package after each install (or skip-with-version) settles.
   * The server uses this to upsert user_packages so the Packages page
   * reflects the auto-essentials state. Default is a no-op so existing
   * tests keep working without wiring this dep.
   */
  onResult: (result: EssentialResult) => void;
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
  readVersion: (spec) => readVersion(spec.versionCmd),
  log: () => undefined,
  onResult: () => undefined,
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
  const present: EssentialSpec[] = [];

  for (const s of specs) {
    if (await deps.binExists(s.binName)) {
      skipped.push(s.packageId);
      present.push(s);
    } else {
      missing.push(s);
    }
  }

  // For already-installed binaries the server still needs an authoritative
  // version + state record (the row may have been wiped while the volume
  // survived). Read the version best-effort and emit the result. Runs in
  // parallel with install; readVersion failures are non-fatal.
  const presentPromise = Promise.all(
    present.map(async (s) => {
      let version: string | null = null;
      try {
        version = await deps.readVersion(s);
      } catch {
        /* leave version null — agent still reports ok */
      }
      const out: EssentialResult = { packageId: s.packageId, ok: true };
      if (version !== null) out.version = version;
      deps.onResult(out);
    }),
  );

  if (missing.length === 0) {
    await presentPromise;
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
          const out: EssentialResult = { packageId: s.packageId, ok: true };
          if (result.version !== undefined) out.version = result.version;
          deps.onResult(out);
        } else {
          failed.push(s.packageId);
          const err = result.error ?? "unknown error";
          deps.log(`[essentials] ${s.packageId} failed: ${err}`);
          deps.onResult({ packageId: s.packageId, ok: false, error: err });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failed.push(s.packageId);
        deps.log(`[essentials] ${s.packageId} failed: ${msg}`);
        deps.onResult({ packageId: s.packageId, ok: false, error: msg });
      }
    }),
  );

  await presentPromise;

  return { installed, skipped, failed };
}
