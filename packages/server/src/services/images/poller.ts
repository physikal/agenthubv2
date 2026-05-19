import { db, schema } from "../../db/index.js";
import { CATALOG, CATALOG_KEYS } from "./catalog.js";
import { EnvOverrides } from "./env-overrides.js";
import {
  PIN_POLICY,
  classify,
  newestAcrossMajor,
  newestWithinMajor,
  parsePinnedRef,
} from "./pin-policy.js";
import type { RegistryClient } from "./registry-client.js";
import type { SemverParts } from "./pin-policy.js";
import type { ImageKey } from "./types.js";

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const JITTER_MS = 2 * 60 * 1000;
const MAX_PAGES = 5;

export class ImagePoller {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly env: EnvOverrides,
    private readonly registry: RegistryClient,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
  ) {}

  start(): void {
    void this.tick();
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    for (const image of CATALOG_KEYS) {
      try {
        await this.tickOne(image);
      } catch (err) {
        this.upsertError(image, err);
      }
    }
  }

  private scheduleNext(): void {
    const jitter = (Math.random() * 2 - 1) * JITTER_MS;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext());
    }, this.intervalMs + jitter);
    this.timer.unref();
  }

  private async tickOne(image: ImageKey): Promise<void> {
    const entry = CATALOG[image];
    const pinnedRef = this.env.readPin(image);
    const { tag: pinnedTag } = parsePinnedRef(pinnedRef);
    const policy = PIN_POLICY[image];

    if (policy.mode === "digest") {
      const digest = await this.registry.getDigest(entry.repo, pinnedTag);
      this.upsertRow({
        image, pinnedTag: pinnedRef,
        newestWithinMajor: null, newestAcrossMajor: null,
        upstreamDigest: digest,
      });
      return;
    }

    const tags = await this.registry.listTags(entry.repo, MAX_PAGES);
    const parsed: SemverParts[] = [];
    for (const t of tags) {
      const r = classify(t, policy);
      if (r !== "unknown") parsed.push(r);
    }
    const pinnedParts = classify(pinnedTag, policy);
    if (pinnedParts === "unknown") {
      this.upsertRow({
        image, pinnedTag: pinnedRef,
        newestWithinMajor: null, newestAcrossMajor: null, upstreamDigest: null,
      });
      return;
    }
    this.upsertRow({
      image, pinnedTag: pinnedRef,
      newestWithinMajor: newestWithinMajor(parsed, pinnedParts.major, pinnedParts.variant, pinnedParts)?.raw ?? null,
      newestAcrossMajor: newestAcrossMajor(parsed, pinnedParts.major)?.raw ?? null,
      upstreamDigest: null,
    });
  }

  private upsertRow(row: {
    image: ImageKey;
    pinnedTag: string;
    newestWithinMajor: string | null;
    newestAcrossMajor: string | null;
    upstreamDigest: string | null;
  }): void {
    const now = new Date();
    db.insert(schema.imageVersionCache)
      .values({
        image: row.image,
        pinnedTag: row.pinnedTag,
        newestWithinMajor: row.newestWithinMajor,
        newestAcrossMajor: row.newestAcrossMajor,
        upstreamDigest: row.upstreamDigest,
        lastCheckedAt: now,
        lastError: null,
      })
      .onConflictDoUpdate({
        target: schema.imageVersionCache.image,
        set: {
          pinnedTag: row.pinnedTag,
          newestWithinMajor: row.newestWithinMajor,
          newestAcrossMajor: row.newestAcrossMajor,
          upstreamDigest: row.upstreamDigest,
          lastCheckedAt: now,
          lastError: null,
        },
      })
      .run();
  }

  private upsertError(image: ImageKey, err: unknown): void {
    const now = new Date();
    const msg = err instanceof Error ? err.message : String(err);
    db.insert(schema.imageVersionCache)
      .values({
        image,
        pinnedTag: this.env.readPin(image),
        newestWithinMajor: null,
        newestAcrossMajor: null,
        upstreamDigest: null,
        lastCheckedAt: now,
        lastError: msg,
      })
      .onConflictDoUpdate({
        target: schema.imageVersionCache.image,
        set: { lastCheckedAt: now, lastError: msg },
      })
      .run();
  }
}
