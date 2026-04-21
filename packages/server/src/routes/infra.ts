import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { AuthUser } from "../middleware/auth.js";
import {
  provisionHostingNode as provisionProxmox,
  verifyHostingNode as verifyProxmox,
  destroyHostingNode as destroyProxmox,
} from "../services/providers/proxmox-hosting.js";

interface ProxmoxConfigInput {
  apiUrl: string;
  tokenId: string;
  tokenSecret: string;
  node: string;
  storage: string;
}

const MASKED_FIELDS = new Set([
  "tokenSecret",
  "apiToken",
]);

function maskConfig(configJson: string): Record<string, unknown> {
  const parsed = JSON.parse(configJson) as Record<string, unknown>;
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (MASKED_FIELDS.has(key) && typeof value === "string" && value.length > 4) {
      masked[key] = "\u2022".repeat(8) + value.slice(-4);
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

function isValidProxmoxConfig(config: Record<string, unknown>): boolean {
  return !!(config["apiUrl"] && config["tokenId"] && config["tokenSecret"] && config["node"] && config["storage"]);
}

function isValidCloudflareConfig(config: Record<string, unknown>): boolean {
  return !!(config["apiToken"] && config["zoneId"]);
}

export function infraRoutes() {
  const app = new Hono<{ Variables: { user: AuthUser } }>();

  // List user's infrastructure configs
  app.get("/", (c) => {
    const user = c.get("user");
    const rows = db
      .select()
      .from(schema.infrastructureConfigs)
      .where(eq(schema.infrastructureConfigs.userId, user.id))
      .all();

    return c.json(
      rows.map((row) => ({
        ...row,
        config: maskConfig(row.config),
      })),
    );
  });

  // Get single config
  app.get("/:id", (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const rows = db
      .select()
      .from(schema.infrastructureConfigs)
      .where(
        and(
          eq(schema.infrastructureConfigs.id, id),
          eq(schema.infrastructureConfigs.userId, user.id),
        ),
      )
      .all();

    const row = rows[0];
    if (!row) return c.json({ error: "Not found" }, 404);

    return c.json({ ...row, config: maskConfig(row.config) });
  });

  // Create new infrastructure config
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

    if (!["proxmox", "cloudflare"].includes(body.provider)) {
      return c.json({ error: "Provider must be proxmox or cloudflare" }, 400);
    }

    if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,62}$/.test(body.name.trim())) {
      return c.json({ error: "Name must be alphanumeric with spaces/hyphens, 1-63 chars" }, 400);
    }

    if (body.provider === "proxmox" && !isValidProxmoxConfig(body.config)) {
      return c.json({ error: "apiUrl, tokenId, tokenSecret, node, and storage required" }, 400);
    }

    if (body.provider === "cloudflare" && !isValidCloudflareConfig(body.config)) {
      return c.json({ error: "apiToken and zoneId required" }, 400);
    }

    // Check for duplicate name
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

    const now = new Date();
    const id = randomUUID();
    db.insert(schema.infrastructureConfigs)
      .values({
        id,
        userId: user.id,
        name: body.name.trim(),
        provider: body.provider as "proxmox" | "cloudflare",
        config: JSON.stringify(body.config),
        status: body.provider === "cloudflare" ? "ready" : "pending",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return c.json({ id, created: true }, 201);
  });

  // Update existing infrastructure config
  app.put("/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const body = await c.req.json<{
      name?: string | undefined;
      config?: Record<string, unknown> | undefined;
    }>();

    const rows = db
      .select()
      .from(schema.infrastructureConfigs)
      .where(
        and(
          eq(schema.infrastructureConfigs.id, id),
          eq(schema.infrastructureConfigs.userId, user.id),
        ),
      )
      .all();

    const row = rows[0];
    if (!row) return c.json({ error: "Not found" }, 404);

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (body.name?.trim()) {
      updates["name"] = body.name.trim();
    }

    if (body.config) {
      // Merge secrets — keep old if masked/empty
      const oldConfig = JSON.parse(row.config) as Record<string, unknown>;
      const newConfig = { ...body.config } as Record<string, string | undefined>;
      for (const field of MASKED_FIELDS) {
        const val = newConfig[field];
        if (!val || val.startsWith("\u2022")) {
          newConfig[field] = oldConfig[field] as string;
        }
      }
      updates["config"] = JSON.stringify(newConfig);
    }

    db.update(schema.infrastructureConfigs)
      .set(updates)
      .where(eq(schema.infrastructureConfigs.id, id))
      .run();

    return c.json({ id, updated: true });
  });

  // Delete infrastructure config
  app.delete("/:id", (c) => {
    const user = c.get("user");
    const id = c.req.param("id");

    const rows = db
      .select()
      .from(schema.infrastructureConfigs)
      .where(
        and(
          eq(schema.infrastructureConfigs.id, id),
          eq(schema.infrastructureConfigs.userId, user.id),
        ),
      )
      .all();

    if (!rows[0]) return c.json({ error: "Not found" }, 404);

    // Check for active deployments
    const activeDeploys = db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.infraId, id))
      .all()
      .filter((d) => d.status !== "destroyed");

    if (activeDeploys.length > 0) {
      return c.json(
        { error: "Cannot delete: active deployments exist" },
        409,
      );
    }

    db.delete(schema.infrastructureConfigs)
      .where(eq(schema.infrastructureConfigs.id, id))
      .run();

    return c.json({ deleted: true });
  });

  // Provision hosting node
  app.post("/:id/provision", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");

    const rows = db
      .select()
      .from(schema.infrastructureConfigs)
      .where(
        and(
          eq(schema.infrastructureConfigs.id, id),
          eq(schema.infrastructureConfigs.userId, user.id),
        ),
      )
      .all();

    const row = rows[0];
    if (!row) return c.json({ error: "Not found" }, 404);

    if (row.status === "ready") {
      return c.json({ error: "Already provisioned" }, 409);
    }
    if (row.status === "provisioning") {
      return c.json({ error: "Provisioning in progress" }, 409);
    }

    // Mark as provisioning
    db.update(schema.infrastructureConfigs)
      .set({ status: "provisioning", statusDetail: "Starting...", updatedAt: new Date() })
      .where(eq(schema.infrastructureConfigs.id, id))
      .run();

    // Return immediately — provision in background
    void (async () => {
      try {
        if (row.provider === "proxmox") {
          await provisionProxmoxNode(id, row.config, user.id);
        } else {
          throw new Error(`Unknown provider: ${row.provider}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(`[infra] Provisioning failed for user ${user.id}:`, message);

        db.update(schema.infrastructureConfigs)
          .set({
            status: "error",
            statusDetail: message,
            updatedAt: new Date(),
          })
          .where(eq(schema.infrastructureConfigs.id, id))
          .run();
      }
    })();

    return c.json({ status: "provisioning" });
  });

  // Check hosting node status
  app.get("/:id/status", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");

    const rows = db
      .select()
      .from(schema.infrastructureConfigs)
      .where(
        and(
          eq(schema.infrastructureConfigs.id, id),
          eq(schema.infrastructureConfigs.userId, user.id),
        ),
      )
      .all();

    const row = rows[0];
    if (!row) return c.json({ error: "Not found" }, 404);

    const response: Record<string, unknown> = {
      status: row.status,
      statusDetail: row.statusDetail,
      hostingNodeIp: row.hostingNodeIp,
      hostingNodeId: row.hostingNodeId,
    };

    // If ready, do a quick health check
    if (row.status === "ready" && row.hostingNodeIp) {
      response["healthy"] = await verifyProxmox(row.hostingNodeIp);
    }

    return c.json(response);
  });

  // Destroy hosting node
  app.delete("/:id/hosting-node", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");

    const rows = db
      .select()
      .from(schema.infrastructureConfigs)
      .where(
        and(
          eq(schema.infrastructureConfigs.id, id),
          eq(schema.infrastructureConfigs.userId, user.id),
        ),
      )
      .all();

    const row = rows[0];
    if (!row) return c.json({ error: "Not found" }, 404);
    if (!row.hostingNodeId) {
      return c.json({ error: "No hosting node to destroy" }, 400);
    }

    if (row.provider === "proxmox") {
      if (!row.hostingNodeNode) {
        return c.json({ error: "Missing node info for Proxmox destroy" }, 400);
      }
      const config = JSON.parse(row.config) as ProxmoxConfigInput;
      await destroyProxmox(config, row.hostingNodeId, row.hostingNodeNode);
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

  return app;
}

// --- Provider-specific provisioning ---

async function provisionProxmoxNode(
  infraId: string,
  configJson: string,
  userId: string,
): Promise<void> {
  const config = JSON.parse(configJson) as ProxmoxConfigInput;

  updateInfra(infraId, { statusDetail: "Creating container..." });
  const result = await provisionProxmox(config);

  updateInfra(infraId, { statusDetail: "Verifying Docker + Traefik..." });
  const verified = await verifyProxmox(result.ip);
  if (!verified) throw new Error("Docker verification failed on hosting node");

  db.update(schema.infrastructureConfigs)
    .set({
      status: "ready",
      statusDetail: null,
      hostingNodeIp: result.ip,
      hostingNodeId: result.vmid,
      hostingNodeNode: result.node,
      updatedAt: new Date(),
    })
    .where(eq(schema.infrastructureConfigs.id, infraId))
    .run();

  console.log(`[infra] Proxmox hosting node provisioned for user ${userId}: VMID ${result.vmid} at ${result.ip}`);
}

function updateInfra(
  id: string,
  updates: Partial<{ statusDetail: string }>,
): void {
  db.update(schema.infrastructureConfigs)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(schema.infrastructureConfigs.id, id))
    .run();
}
