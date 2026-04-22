/**
 * Installable coding-agent CLI catalog.
 *
 * Built-in entries (isBuiltin: true) are baked into the workspace image at
 * `docker/Dockerfile.agent-workspace` and show up in the UI as
 * "Pre-installed" — no install or remove actions. Everything else is
 * installed per-user into `/home/coder/.local/bin` on demand by the agent
 * daemon, using one of three hardcoded methods (npm / curl-sh / binary).
 *
 * Adding a new installable package: append a manifest entry here. The
 * install command templates live in `packages/agent/src/package-ops.ts` —
 * this file only describes WHAT to install, not HOW.
 */

export type InstallMethod = "npm" | "curl-sh" | "binary";

export type InstallSpec =
  | { method: "npm"; npmPackage: string }
  | {
      method: "curl-sh";
      scriptUrl: string;
      scriptEnv?: Readonly<Record<string, string>>;
    }
  | { method: "binary"; url: string; stripComponents?: number };

export interface PackageManifest {
  /** Stable slug — URL-safe, matches `/^[a-z][a-z0-9-]{0,63}$/`. */
  id: string;
  /** Human display name. */
  name: string;
  description: string;
  homepage?: string;
  /** Pre-installed in image. Remove is refused at the server. */
  isBuiltin?: boolean;
  /** Executable name on PATH after install (for verify + cleanup). */
  binName: string;
  /** Argv used to capture the installed version for display. */
  versionCmd: readonly string[];
  install: InstallSpec;
}

const PACKAGE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

const MANIFESTS: readonly PackageManifest[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Anthropic's official coding agent CLI.",
    homepage: "https://docs.claude.com/en/docs/claude-code/overview",
    isBuiltin: true,
    binName: "claude",
    versionCmd: ["claude", "--version"],
    install: { method: "npm", npmPackage: "@anthropic-ai/claude-code" },
  },
  {
    id: "opencode",
    name: "OpenCode",
    description: "Multi-model coding agent CLI.",
    homepage: "https://opencode.ai",
    isBuiltin: true,
    binName: "opencode",
    versionCmd: ["opencode", "--version"],
    install: { method: "npm", npmPackage: "opencode-ai" },
  },
  {
    id: "minimax",
    name: "MiniMax",
    description: "MiniMax agent CLI (invoked via `mmx` or `claude-minimax`).",
    homepage: "https://www.minimax.io",
    isBuiltin: true,
    binName: "mmx",
    versionCmd: ["mmx", "--version"],
    install: { method: "npm", npmPackage: "mmx-cli" },
  },
  {
    id: "droid",
    name: "Droid (Factory AI)",
    description: "Factory AI's autonomous coding agent CLI.",
    homepage: "https://app.factory.ai",
    binName: "droid",
    versionCmd: ["droid", "--version"],
    // Official installer URL — verify at deploy time; if Factory changes
    // the install path, only this line needs updating.
    install: {
      method: "curl-sh",
      scriptUrl: "https://app.factory.ai/cli",
    },
  },
];

function validateManifest(m: PackageManifest): void {
  if (!PACKAGE_ID_RE.test(m.id)) {
    throw new Error(`invalid package id: ${m.id}`);
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(m.binName)) {
    throw new Error(`invalid binName for ${m.id}: ${m.binName}`);
  }
  if (m.versionCmd.length === 0) {
    throw new Error(`empty versionCmd for ${m.id}`);
  }
  if (m.install.method === "curl-sh" || m.install.method === "binary") {
    const url = m.install.method === "curl-sh"
      ? m.install.scriptUrl
      : m.install.url;
    if (!url.startsWith("https://")) {
      throw new Error(`${m.id}: install url must be https`);
    }
  }
  if (m.install.method === "npm") {
    if (!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]{0,213}$/.test(m.install.npmPackage)) {
      throw new Error(`${m.id}: invalid npm package name`);
    }
  }
}

for (const m of MANIFESTS) validateManifest(m);

const CATALOG = new Map(MANIFESTS.map((m) => [m.id, m] as const));

export function listCatalog(): readonly PackageManifest[] {
  return MANIFESTS;
}

export function getPackage(packageId: string): PackageManifest | undefined {
  return CATALOG.get(packageId);
}
