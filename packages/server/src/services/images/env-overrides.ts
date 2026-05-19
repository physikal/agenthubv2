import {
  copyFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { CATALOG } from "./catalog.js";
import type { ImageKey } from "./types.js";

interface EnvOverridesConfig {
  readonly envPath: string;
}

export class EnvOverrides {
  private readonly envPath: string;
  private readonly envDir: string;
  private readonly envBase: string;

  constructor(cfg: EnvOverridesConfig) {
    this.envPath = cfg.envPath;
    this.envDir = dirname(cfg.envPath);
    this.envBase = basename(cfg.envPath);
  }

  /** Returns the current pin for an image: env override if present, else catalog default. */
  readPin(image: ImageKey): string {
    const entry = CATALOG[image];
    const env = this.readEnvMap();
    return env.get(entry.envVar) ?? entry.defaultPin;
  }

  /**
   * Atomic upsert of the env-var line for one image. Writes to a sibling
   * `.tmp` file then renames into place so a crash mid-write can't leave
   * a half-written .env.
   */
  writePin(image: ImageKey, fullImageRef: string): void {
    const entry = CATALOG[image];
    const lines = this.readLines();
    const key = entry.envVar;
    let replaced = false;
    const next = lines.map((line) => {
      if (line.startsWith(`${key}=`)) {
        replaced = true;
        return `${key}=${fullImageRef}`;
      }
      return line;
    });
    if (!replaced) next.push(`${key}=${fullImageRef}`);
    const tmp = `${this.envPath}.tmp`;
    writeFileSync(tmp, `${next.join("\n")}\n`, { mode: 0o600 });
    renameSync(tmp, this.envPath);
  }

  backupEnv(): string {
    // ISO with `:` replaced — colons aren't valid in some filesystems and
    // are awkward in shell globs.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let path = join(this.envDir, `${this.envBase}.bak-${stamp}`);
    // Distinguish rapid-succession backups within the same millisecond by
    // appending an incrementing counter so filenames never collide.
    let counter = 0;
    while (counter < 1000) {
      const candidate =
        counter === 0
          ? path
          : join(this.envDir, `${this.envBase}.bak-${stamp}-${counter}`);
      try {
        // copyFileSync with COPYFILE_EXCL flag (mode 1) fails if dest exists
        copyFileSync(this.envPath, candidate, 1);
        return candidate;
      } catch {
        counter++;
        path = candidate;
      }
    }
    // Fallback: overwrite (should never reach here in practice)
    copyFileSync(this.envPath, path);
    return path;
  }

  restoreEnv(backupPath: string): void {
    copyFileSync(backupPath, this.envPath);
  }

  pruneOldBackups(keep: number): void {
    const prefix = `${this.envBase}.bak-`;
    const candidates = readdirSync(this.envDir)
      .filter((f) => f.startsWith(prefix))
      .sort(); // ISO timestamps sort lexicographically
    const toDelete = candidates.slice(0, Math.max(0, candidates.length - keep));
    for (const f of toDelete) unlinkSync(join(this.envDir, f));
  }

  private readLines(): string[] {
    const raw = readFileSync(this.envPath, "utf8");
    // Drop the trailing empty string if file ends in newline
    const lines = raw.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  private readEnvMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const line of this.readLines()) {
      if (line.startsWith("#") || line.trim() === "") continue;
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      map.set(line.slice(0, idx), line.slice(idx + 1));
    }
    return map;
  }
}
