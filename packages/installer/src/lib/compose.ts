import { spawn } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { InstallConfig } from "./config.js";
import { renderEnv } from "./config.js";

/**
 * Locate the repo's `compose/` directory. Works for both dev (file://...) and
 * packaged (node_modules/@agenthub/installer/dist) contexts by walking up.
 */
export function findComposeDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "compose", "docker-compose.yml");
    if (existsSync(candidate)) return join(dir, "compose");
    dir = dirname(dir);
  }
  // Packaged fallback: installer bundles compose/ under dist/
  const packaged = join(here, "..", "compose");
  if (existsSync(join(packaged, "docker-compose.yml"))) return packaged;
  throw new Error(
    "Could not locate AgentHub compose bundle. " +
      "Run from a checkout of the repo or reinstall @agenthub/installer.",
  );
}

export function writeEnvFile(cfg: InstallConfig, targetDir: string): string {
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  const path = resolve(targetDir, ".env");
  writeFileSync(path, renderEnv(cfg), { mode: 0o600 });
  return path;
}

export interface ComposeUpOptions {
  composeDir: string;
  envFile: string;
  withDokployOverlay: boolean;
  onLine?: (line: string) => void;
}

/**
 * Run `docker compose up -d` with the right file flags. Streams stdout/stderr
 * line-by-line to onLine so the Ink UI can show progress without stalling.
 */
export function composeUp(opts: ComposeUpOptions): Promise<void> {
  // --pull never — composePull() already pulled every registry-backed
  // image with --ignore-pull-failures. At this point everything we need
  // is local; re-pulling agenthubv2-server:local would hit docker.io
  // (where that tag doesn't exist) and fail the install.
  return runCompose(["up", "-d", "--pull", "never"], opts);
}

// Matches the confusing-looking-but-benign line compose emits when it can't
// find a locally-tagged image (`agenthubv2-server:local`, etc.) in a
// registry during pull. `--ignore-pull-failures` already handles it; we
// just drop the line so humans don't mistake it for a real error.
const BENIGN_PULL_NOISE = /Error pull access denied for agenthubv2-[^ ]+, repository does not exist/;

export function composePull(opts: ComposeUpOptions): Promise<void> {
  // --ignore-pull-failures so locally-built images (`agenthubv2-server:local`,
  // etc.) don't break the install. Registry pulls still happen for everything
  // else (Postgres, Redis, Traefik, Infisical).
  const filtered: ComposeUpOptions = {
    ...opts,
    onLine: (line: string) => {
      if (BENIGN_PULL_NOISE.test(line)) return;
      opts.onLine?.(line);
    },
  };
  return runCompose(["pull", "--ignore-pull-failures"], filtered);
}

export interface RecreateServiceOptions extends ComposeUpOptions {
  service: string;
}

/** `docker compose up -d --force-recreate <service>` to pick up new env. */
export function recreateService(opts: RecreateServiceOptions): Promise<void> {
  return runCompose(
    ["up", "-d", "--pull", "never", "--force-recreate", opts.service],
    opts,
  );
}

function runCompose(
  subcommand: string[],
  opts: ComposeUpOptions,
): Promise<void> {
  const files = [
    "-f",
    join(opts.composeDir, "docker-compose.yml"),
  ];
  if (opts.withDokployOverlay) {
    files.push("-f", join(opts.composeDir, "docker-compose.dokploy.yml"));
  }

  return new Promise((resolvePromise, reject) => {
    const proc = spawn(
      "docker",
      ["compose", "--env-file", opts.envFile, ...files, ...subcommand],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const forward = (chunk: Buffer): void => {
      const str = chunk.toString();
      for (const line of str.split(/\r?\n/)) {
        if (line) opts.onLine?.(line);
      }
    };
    proc.stdout.on("data", forward);
    proc.stderr.on("data", forward);

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`docker compose ${subcommand.join(" ")} exited ${String(code)}`));
    });
  });
}
