import type { InstallSpec } from "./package-ops.js";

export interface EssentialSpec {
  packageId: string;
  binName: string;
  versionCmd: readonly string[];
  install: InstallSpec;
}

export type PackagesInbound =
  | { type: "essentials.ensure"; specs: EssentialSpec[] };

export type PackagesOutbound =
  | { type: "essentials.line"; packageId: string; line: string }
  | { type: "essentials.result"; packageId: string; ok: boolean; version?: string; error?: string }
  | { type: "essentials.done"; installed: string[]; skipped: string[]; failed: string[] };
