import type {
  HostingProvider,
  ProviderConfigCheck,
  ProvisionResult,
} from "./types.js";

const DO_API = "https://api.digitalocean.com/v2";

/**
 * DigitalOcean hosting provider.
 *
 * Config shape:
 *   { apiToken: "dop_v1_...", region: "sfo3", size: "s-2vcpu-2gb",
 *     image: "docker-20-04", sshKeyId: 12345 }
 *
 * provision() creates a droplet with the supplied SSH key ID, waits for it
 * to report active, and returns its IPv4 address. Downstream, deployer.ts
 * uses that IP + the user's SSH key to `docker compose up` apps on the
 * droplet — identical flow to the docker-hosting provider.
 *
 * Destroy removes the droplet via DO API.
 */
export class DigitalOceanProvider implements HostingProvider {
  readonly name = "digitalocean" as const;

  validate(config: Record<string, unknown>): ProviderConfigCheck {
    const issues: string[] = [];
    if (typeof config["apiToken"] !== "string" || !config["apiToken"]) {
      issues.push("apiToken is required");
    }
    if (typeof config["region"] !== "string" || !config["region"]) {
      issues.push("region is required (e.g., sfo3, nyc3, lon1)");
    }
    if (typeof config["sshKeyId"] !== "number" && typeof config["sshKeyId"] !== "string") {
      issues.push("sshKeyId is required — numeric ID or fingerprint");
    }
    return { ok: issues.length === 0, issues };
  }

  async verify(config: Record<string, unknown>): Promise<ProviderConfigCheck> {
    const base = this.validate(config);
    if (!base.ok) return base;

    try {
      const resp = await fetch(`${DO_API}/account`, {
        headers: { Authorization: `Bearer ${config["apiToken"] as string}` },
      });
      if (!resp.ok) {
        return { ok: false, issues: [`DO API returned ${String(resp.status)}`] };
      }
      return { ok: true, issues: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      return { ok: false, issues: [`DO API unreachable: ${msg}`] };
    }
  }

  async provision(
    config: Record<string, unknown>,
    opts: { userId: string; name: string },
  ): Promise<ProvisionResult> {
    const apiToken = config["apiToken"] as string;
    const region = config["region"] as string;
    const size = (config["size"] as string | undefined) ?? "s-2vcpu-4gb";
    const image = (config["image"] as string | undefined) ?? "docker-20-04";
    const sshKeyId = config["sshKeyId"] as number | string;

    // Create droplet.
    const createResp = await fetch(`${DO_API}/droplets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `agenthub-${opts.userId.slice(0, 8)}-${opts.name}`.toLowerCase(),
        region,
        size,
        image,
        ssh_keys: [sshKeyId],
        backups: false,
        ipv6: false,
        tags: ["agenthub", `user:${opts.userId}`],
      }),
    });

    if (!createResp.ok) {
      throw new Error(
        `DigitalOcean droplet create failed (${String(createResp.status)}): ${await createResp.text()}`,
      );
    }

    const created = (await createResp.json()) as {
      droplet: { id: number; networks: { v4: { ip_address: string; type: string }[] } };
    };
    const dropletId = created.droplet.id;

    // Poll for active status + public IP.
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await sleep(5_000);
      const statusResp = await fetch(`${DO_API}/droplets/${String(dropletId)}`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      if (!statusResp.ok) continue;
      const data = (await statusResp.json()) as {
        droplet: { status: string; networks: { v4: { ip_address: string; type: string }[] } };
      };
      const ip = data.droplet.networks.v4.find((n) => n.type === "public")?.ip_address;
      if (data.droplet.status === "active" && ip) {
        return {
          hostingNodeIp: ip,
          hostingNodeId: String(dropletId),
          hostingNodeLabel: region,
        };
      }
    }

    throw new Error(`droplet ${String(dropletId)} did not become active within 5m`);
  }

  async destroy(
    config: Record<string, unknown>,
    hostingNodeId: string,
  ): Promise<void> {
    const apiToken = config["apiToken"] as string;
    const resp = await fetch(`${DO_API}/droplets/${hostingNodeId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!resp.ok && resp.status !== 404) {
      throw new Error(
        `DigitalOcean destroy failed (${String(resp.status)}): ${await resp.text()}`,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
