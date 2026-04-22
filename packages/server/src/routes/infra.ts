import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { AuthUser } from "../middleware/auth.js";
import {
  splitSecrets,
  resolveInfraConfig,
  storeInfraSecrets,
  deleteInfraSecrets,
} from "../services/secrets/helpers.js";
import {
  getSecretStore,
  SecretStoreNotConfiguredError,
} from "../services/secrets/index.js";
import { getHostingProvider } from "../services/providers/index.js";

/**
 * Phase 2 minimum: manage Cloudflare DNS infra configs. The inner-MCP deploy
 * targets (Docker / DigitalOcean / Dokploy) are scaffolded in the schema and
 * land in Phase 5 with their own provision/verify/destroy flows.
 */

const MASKED_FIELDS = new Set([
  "tokenSecret",
  "apiToken",
  "sshPrivateKey",
  "b2AppKey",
]);
type Provider = (typeof schema.infrastructureConfigs.$inferSelect)["provider"];
const KNOWN_PROVIDERS: Provider[] = [
  "docker",
  "digitalocean",
  "dokploy",
  "cloudflare",
  "b2",
];
const FULLY_IMPLEMENTED: Provider[] = [
  "cloudflare",
  "docker",
  "digitalocean",
  "dokploy",
  "b2",
];

function maskConfig(configJson: string): Record<string, unknown> {
  const parsed = JSON.parse(configJson) as Record<string, unknown>;
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (MASKED_FIELDS.has(key) && typeof value === "string" && value.length > 4) {
      masked[key] = "•".repeat(8) + value.slice(-4);
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

function validateConfigForProvider(
  provider: string,
  config: Record<string, unknown>,
): { ok: boolean; issues: string[] } {
  // Non-compute providers validated inline here (no HostingProvider class):
  if (provider === "cloudflare") {
    const issues: string[] = [];
    if (!config["apiToken"]) issues.push("apiToken required");
    if (!config["zoneId"]) issues.push("zoneId required");
    return { ok: issues.length === 0, issues };
  }
  if (provider === "b2") {
    const issues: string[] = [];
    if (!config["b2KeyId"]) issues.push("b2KeyId required");
    if (!config["b2AppKey"]) issues.push("b2AppKey required");
    if (!config["b2Bucket"]) issues.push("b2Bucket required");
    return { ok: issues.length === 0, issues };
  }
  // Compute providers: defer to the HostingProvider's own validate() so we
  // don't duplicate the per-provider field list here.
  const hostingProvider = getHostingProvider(provider);
  if (hostingProvider) return hostingProvider.validate(config);
  return { ok: false, issues: [`unknown provider: ${provider}`] };
}

export function infraRoutes() {
  const app = new Hono<{ Variables: { user: AuthUser } }>();

  app.get("/", async (c) => {
    const user = c.get("user");
    const rows = db
      .select()
      .from(schema.infrastructureConfigs)
      .where(eq(schema.infrastructureConfigs.userId, user.id))
      .all();

    // Metadata-only render — secrets stay in Infisical. Listing many configs
    // does not pay the per-config Infisical round-trip.
    return c.json(
      rows.map((row) => ({ ...row, config: maskConfig(row.config) })),
    );
  });

  app.get("/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const row = db
      .select()
      .from(schema.infrastructureConfigs)
      .where(
        and(
          eq(schema.infrastructureConfigs.id, id),
          eq(schema.infrastructureConfigs.userId, user.id),
        ),
      )
      .get();
    if (!row) return c.json({ error: "Not found" }, 404);
    // Single-config view: resolve secrets from Infisical so the UI can show
    // the masked real value (last 4 chars) instead of blank fields.
    const metadata = JSON.parse(row.config) as Record<string, unknown>;
    const full = await resolveInfraConfig(user.id, id, metadata);
    return c.json({ ...row, config: maskConfig(JSON.stringify(full)) });
  });

  // Provisioning status — cheap DB read, no Infisical round-trip. UI polls
  // this every few seconds while status === 'provisioning'.
  app.get("/:id/status", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const row = db
      .select({
        status: schema.infrastructureConfigs.status,
        statusDetail: schema.infrastructureConfigs.statusDetail,
        hostingNodeIp: schema.infrastructureConfigs.hostingNodeIp,
        hostingNodeId: schema.infrastructureConfigs.hostingNodeId,
        hostingNodeNode: schema.infrastructureConfigs.hostingNodeNode,
      })
      .from(schema.infrastructureConfigs)
      .where(
        and(
          eq(schema.infrastructureConfigs.id, id),
          eq(schema.infrastructureConfigs.userId, user.id),
        ),
      )
      .get();
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(row);
  });

  app.post("/", async (c) => {
    const user = c.get("user");
    const body = await c.req.json<{
      name: string;
      provider: string;
      config: Record<string, unknown>;
    }>();

    if (!body.name?.trim() || !body.provider || !body.config) {
      return c.json({ error: "name, provider, and config required" }, 400);
    }

    if (!(KNOWN_PROVIDERS as string[]).includes(body.provider)) {
      return c.json(
        { error: `provider must be one of: ${KNOWN_PROVIDERS.join(", ")}` },
        400,
      );
    }

    if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,62}$/.test(body.name.trim())) {
      return c.json(
        { error: "Name must be alphanumeric with spaces/hyphens, 1-63 chars" },
        400,
      );
    }

    const validation = validateConfigForProvider(body.provider, body.config);
    if (!validation.ok) {
      return c.json({ error: validation.issues.join(", ") }, 400);
    }

    if (!(FULLY_IMPLEMENTED as string[]).includes(body.provider)) {
      return c.json(
        {
          error:
            `provider "${body.provider}" is scaffolded but not yet wired`,
        },
        501,
      );
    }

    const existing = db
      .select()
      .from(schema.infrastructureConfigs)
      .where(
        and(
          eq(schema.infrastructureConfigs.userId, user.id),
          eq(schema.infrastructureConfigs.name, body.name.trim()),
        ),
      )
      .all();

    if (existing.length > 0) {
      return c.json({ error: `Config "${body.name.trim()}" already exists` }, 409);
    }

    const { metadata, secrets } = splitSecrets(body.provider, body.config);
    const store = getSecretStore();
    if (Object.keys(secrets).length > 0 && !store.configured) {
      return c.json(
        { error: "Secret store not configured — cannot store provider credentials" },
        503,
      );
    }

    const now = new Date();
    const id = randomUUID();
    try {
      await storeInfraSecrets(user.id, id, secrets);
    } catch (err) {
      if (err instanceof SecretStoreNotConfiguredError) {
        return c.json({ error: err.message }, 503);
      }
      throw err;
    }

    db.insert(schema.infrastructureConfigs)
      .values({
        id,
        userId: user.id,
        name: body.name.trim(),
        provider: body.provider as Provider,
        config: JSON.stringify(metadata),
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return c.json({ id, created: true }, 201);
  });

  app.put("/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const body = await c.req.json<{
      name?: string | undefined;
      config?: Record<string, unknown> | undefined;
    }>();

    const row = db
      .select()
      .from(schema.infrastructureConfigs)
      .where(
        and(
          eq(schema.infrastructureConfigs.id, id),
          eq(schema.infrastructureConfigs.userId, user.id),
        ),
      )
      .get();

    if (!row) return c.json({ error: "Not found" }, 404);

    const updates: Partial<typeof schema.infrastructureConfigs.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (body.name?.trim()) {
      updates.name = body.name.trim();
    }

    if (body.config) {
      const { metadata: newMeta, secrets: newSecrets } = splitSecrets(
        row.provider,
        body.config,
      );

      // Merge: unchanged/masked secret fields preserve the existing Infisical
      // value. Only write the fields the user actually changed.
      const changedSecrets: Record<string, string> = {};
      for (const [k, v] of Object.entries(newSecrets)) {
        if (v && !v.startsWith("•")) changedSecrets[k] = v;
      }

      try {
        await storeInfraSecrets(user.id, id, changedSecrets);
      } catch (err) {
        if (err instanceof SecretStoreNotConfiguredError) {
          return c.json({ error: err.message }, 503);
        }
        throw err;
      }

      updates.config = JSON.stringify(newMeta);
    }

    db.update(schema.infrastructureConfigs)
      .set(updates)
      .where(eq(schema.infrastructureConfigs.id, id))
      .run();

    return c.json({ id, updated: true });
  });

  // Probe the provider using stored creds — "are my credentials still good?"
  app.post("/:id/verify", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const row = db
      .select()
      .from(schema.infrastructureConfigs)
      .where(
        and(
          eq(schema.infrastructureConfigs.id, id),
          eq(schema.infrastructureConfigs.userId, user.id),
        ),
      )
      .get();
    if (!row) return c.json({ error: "Not found" }, 404);

    const provider = getHostingProvider(row.provider);
    if (!provider) {
      // Non-hosting provider (cloudflare) has no verify. Return ok.
      return c.json({ ok: true });
    }
    const full = await resolveInfraConfig(
      user.id,
      id,
      JSON.parse(row.config) as Record<string, unknown>,
    );
    const result = await provider.verify(full);
    return c.json(result);
  });

  // Create hosting node (droplet / bootstrap). No-op for byo-docker + dokploy.
  app.post("/:id/provision", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const row = db
      .select()
      .from(schema.infrastructureConfigs)
      .where(
        and(
          eq(schema.infrastructureConfigs.id, id),
          eq(schema.infrastructureConfigs.userId, user.id),
        ),
      )
      .get();
    if (!row) return c.json({ error: "Not found" }, 404);

    const provider = getHostingProvider(row.provider);
    if (!provider) {
      return c.json(
        { error: `provider ${row.provider} does not provision hosting nodes` },
        400,
      );
    }

    db.update(schema.infrastructureConfigs)
      .set({
        status: "provisioning",
        statusDetail: "preparing host",
        updatedAt: new Date(),
      })
      .where(eq(schema.infrastructureConfigs.id, id))
      .run();

    void (async () => {
      try {
        const full = await resolveInfraConfig(
          user.id,
          id,
          JSON.parse(row.config) as Record<string, unknown>,
        );
        const result = await provider.provision(full, { userId: user.id, name: row.name });
        db.update(schema.infrastructureConfigs)
          .set({
            status: "ready",
            statusDetail: null,
            hostingNodeIp: result.hostingNodeIp,
            hostingNodeId: result.hostingNodeId,
            hostingNodeNode: result.hostingNodeLabel ?? null,
            updatedAt: new Date(),
          })
          .where(eq(schema.infrastructureConfigs.id, id))
          .run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        db.update(schema.infrastructureConfigs)
          .set({ status: "error", statusDetail: msg, updatedAt: new Date() })
          .where(eq(schema.infrastructureConfigs.id, id))
          .run();
      }
    })();

    return c.json({ provisioning: true });
  });

  // Destroy ONLY the provisioned compute (droplet/container/etc.) but keep the
  // infra config + credentials. Useful for "pause" or before re-provisioning
  // with updated settings. Active deployments block the destroy.
  app.delete("/:id/hosting-node", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const row = db
      .select()
      .from(schema.infrastructureConfigs)
      .where(
        and(
          eq(schema.infrastructureConfigs.id, id),
          eq(schema.infrastructureConfigs.userId, user.id),
        ),
      )
      .get();
    if (!row) return c.json({ error: "Not found" }, 404);

    if (!row.hostingNodeId) {
      return c.json({ error: "Nothing to destroy: no hosting node provisioned" }, 400);
    }

    const activeDeploys = db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.infraId, id))
      .all()
      .filter((d) => d.status !== "destroyed");
    if (activeDeploys.length > 0) {
      return c.json({ error: "Cannot destroy hosting node: active deployments exist" }, 409);
    }

    const provider = getHostingProvider(row.provider);
    if (!provider) {
      return c.json(
        { error: `provider ${row.provider} does not manage a hosting node` },
        400,
      );
    }

    try {
      const full = await resolveInfraConfig(
        user.id,
        id,
        JSON.parse(row.config) as Record<string, unknown>,
      );
      await provider.destroy(full, row.hostingNodeId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      db.update(schema.infrastructureConfigs)
        .set({ status: "error", statusDetail: `destroy failed: ${msg}`, updatedAt: new Date() })
        .where(eq(schema.infrastructureConfigs.id, id))
        .run();
      return c.json({ error: `destroy failed: ${msg}` }, 500);
    }

    db.update(schema.infrastructureConfigs)
      .set({
        status: "pending",
        statusDetail: null,
        hostingNodeIp: null,
        hostingNodeId: null,
        hostingNodeNode: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.infrastructureConfigs.id, id))
      .run();

    return c.json({ destroyed: true });
  });

  app.delete("/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");

    const row = db
      .select()
      .from(schema.infrastructureConfigs)
      .where(
        and(
          eq(schema.infrastructureConfigs.id, id),
          eq(schema.infrastructureConfigs.userId, user.id),
        ),
      )
      .get();

    if (!row) return c.json({ error: "Not found" }, 404);

    const activeDeploys = db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.infraId, id))
      .all()
      .filter((d) => d.status !== "destroyed");

    if (activeDeploys.length > 0) {
      return c.json({ error: "Cannot delete: active deployments exist" }, 409);
    }

    try {
      await deleteInfraSecrets(user.id, id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.warn(`[infra] failed to purge secrets for ${id}: ${msg} — continuing delete`);
    }

    db.delete(schema.infrastructureConfigs)
      .where(eq(schema.infrastructureConfigs.id, id))
      .run();

    return c.json({ deleted: true });
  });

  return app;
}
