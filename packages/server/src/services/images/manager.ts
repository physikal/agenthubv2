import { spawn } from "node:child_process";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";
import { CATALOG, CATALOG_KEYS } from "./catalog.js";
import type { EnvOverrides } from "./env-overrides.js";
import type { ImageKey } from "./types.js";

export interface ImageRowSummary {
  readonly image: ImageKey;
  readonly displayName: string;
  readonly pinnedTag: string;
  readonly newestWithinMajor: string | null;
  readonly newestAcrossMajor: string | null;
  readonly upstreamDigest: string | null;
  readonly runningDigest: string | null;
  readonly updateAvailable: boolean;
  readonly lastCheckedAt: string | null;
  readonly lastError: string | null;
  readonly disruption: string;
}

export interface UpdatesSummary {
  readonly images: readonly ImageRowSummary[];
}

export type ApplyRequest =
  | { readonly image: ImageKey; readonly tag: string; readonly acknowledgedMajor?: boolean }
  | { readonly image: "infisical"; readonly digestUpdate: true };

export type ApplyEvent =
  | { readonly kind: "phase"; readonly phase: ApplyPhase }
  | { readonly kind: "log"; readonly line: string }
  | { readonly kind: "error"; readonly message: string };

export type ApplyPhase =
  | "validating"
  | "writing-env"
  | "pulling"
  | "recreating"
  | "done"
  | "failed";

export type RunningDigestResolver = (composeService: string) => Promise<string | null>;

/**
 * Build the `-f <file>` flag list for `docker compose`, from the non-magic
 * AGENTHUB_COMPOSE_DIR + AGENTHUB_COMPOSE_FILES env vars (set in
 * compose/docker-compose.yml). FILES is colon-separated, mirroring the host
 * COMPOSE_FILE — so public-mode installs include traefik.override.yml and a
 * service recreate keeps its :443 port + cert resolver.
 *
 * NOT named COMPOSE_FILE: that magic var would override the compose file for
 * every `docker compose` call the server makes, breaking the local-docker
 * deployer (see compose/docker-compose.yml).
 *
 * Dev fallback (vars unset): a single relative compose/docker-compose.yml.
 */
export function composeFileFlags(): string[] {
  const dir = process.env["AGENTHUB_COMPOSE_DIR"];
  const files = process.env["AGENTHUB_COMPOSE_FILES"];
  if (dir && files) {
    const flags = files
      .split(":")
      .map((f) => f.trim())
      .filter(Boolean)
      .flatMap((f) => ["-f", `${dir}/${f}`]);
    if (flags.length > 0) return flags;
  }
  return ["-f", "compose/docker-compose.yml"];
}

export class ImagesManager {
  constructor(
    private readonly env: EnvOverrides,
    private readonly runningDigest: RunningDigestResolver,
  ) {}

  async getUpdatesSummary(): Promise<UpdatesSummary> {
    const rowsByKey = new Map(
      db.select().from(schema.imageVersionCache).all().map((r) => [r.image, r]),
    );
    const images: ImageRowSummary[] = [];
    for (const key of CATALOG_KEYS) {
      const entry = CATALOG[key];
      const row = rowsByKey.get(key);
      const pinnedTag = this.env.readPin(key);
      const newestWithinMajor = row?.newestWithinMajor ?? null;
      const newestAcrossMajor = row?.newestAcrossMajor ?? null;
      const upstreamDigest = row?.upstreamDigest ?? null;
      const runningDigest = upstreamDigest ? await this.runningDigest(entry.composeService) : null;
      const updateAvailable =
        Boolean(newestWithinMajor) ||
        Boolean(newestAcrossMajor) ||
        Boolean(upstreamDigest && runningDigest && upstreamDigest !== runningDigest);
      images.push({
        image: key,
        displayName: entry.displayName,
        pinnedTag,
        newestWithinMajor,
        newestAcrossMajor,
        upstreamDigest,
        runningDigest,
        updateAvailable,
        lastCheckedAt: row?.lastCheckedAt?.toISOString() ?? null,
        lastError: row?.lastError ?? null,
        disruption: entry.disruption,
      });
    }
    return { images };
  }

  validateApply(req: ApplyRequest): void {
    if ("digestUpdate" in req) {
      const cached = db.select().from(schema.imageVersionCache)
        .where(eq(schema.imageVersionCache.image, "infisical")).get();
      if (!cached?.upstreamDigest) throw new Error("no upstream digest cached for infisical");
      return;
    }
    const entry = CATALOG[req.image];
    if (!entry) throw new Error(`unknown image: ${String(req.image)}`);
    const cached = db.select().from(schema.imageVersionCache)
      .where(eq(schema.imageVersionCache.image, req.image)).get();
    if (!cached) throw new Error(`no cache row for ${req.image} — refresh poller first`);
    const allowed = new Set<string>();
    if (cached.newestWithinMajor) allowed.add(cached.newestWithinMajor);
    if (cached.newestAcrossMajor) allowed.add(cached.newestAcrossMajor);
    // Idempotent re-apply of current pin
    const currentTag = this.env.readPin(req.image).split(":").slice(1).join(":");
    if (currentTag) allowed.add(currentTag);
    if (!allowed.has(req.tag)) {
      throw new Error(
        `tag ${req.tag} not in {within=${cached.newestWithinMajor}, ` +
        `across=${cached.newestAcrossMajor}, current=${currentTag}}`,
      );
    }
    if (req.tag === cached.newestAcrossMajor && !req.acknowledgedMajor) {
      throw new Error("major version bump requires acknowledgedMajor=true");
    }
  }

  async applyImageUpdate(
    req: ApplyRequest,
    onEvent: (e: ApplyEvent) => void,
  ): Promise<void> {
    onEvent({ kind: "phase", phase: "validating" });
    this.validateApply(req);

    const entry = CATALOG[req.image];
    onEvent({ kind: "phase", phase: "writing-env" });
    const backupPath = this.env.backupEnv();
    let envChanged = false;
    if (!("digestUpdate" in req)) {
      this.env.writePin(req.image, `${entry.repo}:${req.tag}`);
      envChanged = true;
    }

    const composeFlags = composeFileFlags();
    try {
      onEvent({ kind: "phase", phase: "pulling" });
      await runDocker(["compose", ...composeFlags, "pull", entry.composeService], onEvent);
      onEvent({ kind: "phase", phase: "recreating" });
      await runDocker(
        ["compose", ...composeFlags, "up", "-d", "--no-deps", entry.composeService],
        onEvent,
      );
      onEvent({ kind: "phase", phase: "done" });
      this.env.pruneOldBackups(3);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent({ kind: "error", message: `Apply failed: ${msg}. Rolling back.` });
      if (envChanged) this.env.restoreEnv(backupPath);
      try {
        await runDocker(
          ["compose", ...composeFlags, "up", "-d", "--no-deps", entry.composeService],
          onEvent,
        );
        onEvent({ kind: "phase", phase: "failed" });
      } catch (rollbackErr) {
        const rmsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        onEvent({
          kind: "error",
          message:
            `Rollback also failed: ${rmsg}. Manual intervention required. Backup: ${backupPath}`,
        });
        onEvent({ kind: "phase", phase: "failed" });
      }
    }
  }
}

function runDocker(args: readonly string[], onEvent: (e: ApplyEvent) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const emit = (buf: Buffer) => {
      for (const line of buf.toString("utf8").split(/\r?\n/)) {
        if (line.length > 0) onEvent({ kind: "log", line });
      }
    };
    child.stdout.on("data", emit);
    child.stderr.on("data", emit);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker ${args.join(" ")} exited ${String(code)}`));
    });
  });
}

/**
 * Returns the digest of the image currently running for a given compose
 * service, or null on any failure. Used by the page's "is a new digest
 * available?" detection for digest-mode pins.
 */
export function dockerRunningDigest(): RunningDigestResolver {
  return async (service: string) => {
    return new Promise((resolve) => {
      const child = spawn("docker", [
        "compose",
        ...composeFileFlags(),
        "images", "--quiet", service,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let buf = "";
      child.stdout.on("data", (d: Buffer) => { buf += d.toString("utf8"); });
      child.on("error", () => resolve(null));
      child.on("close", (code) => {
        if (code !== 0) { resolve(null); return; }
        const imageId = buf.trim().split("\n")[0];
        if (!imageId) { resolve(null); return; }
        const inspect = spawn(
          "docker",
          ["inspect", "--format", "{{ (index .RepoDigests 0) }}", imageId],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "";
        inspect.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
        inspect.on("error", () => resolve(null));
        inspect.on("close", (c2) => {
          if (c2 !== 0) { resolve(null); return; }
          const ref = out.trim();
          const at = ref.indexOf("@");
          resolve(at === -1 ? null : ref.slice(at + 1));
        });
      });
    });
  };
}
