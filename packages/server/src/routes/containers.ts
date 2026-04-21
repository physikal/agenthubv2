import { Hono } from "hono";
import type { ProxmoxClient } from "../services/proxmox.js";

export function containersRoutes(proxmox: ProxmoxClient): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const allowedNodes = (process.env["PVE_ALLOWED_NODES"] ?? "pve05,pve06,pve07").split(",");
    const containers = [];

    for (const node of allowedNodes) {
      try {
        const lxcs = await proxmox.listLxc(node);
        for (const lxc of lxcs) {
          if (lxc.name?.startsWith("lxc-agent-")) {
            containers.push({ ...lxc, node });
          }
        }
      } catch {
        // node might be offline
      }
    }

    return c.json(containers);
  });

  app.get("/nodes", async (c) => {
    try {
      const node = await proxmox.selectNode();
      return c.json({ selectedNode: node });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return c.json({ error: msg }, 500);
    }
  });

  return app;
}
