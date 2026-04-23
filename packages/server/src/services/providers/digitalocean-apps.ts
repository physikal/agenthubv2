import type {
  HostingProvider,
  ProviderConfigCheck,
  ProvisionResult,
} from "./types.js";

/**
 * DigitalOcean App Platform target. PaaS — DO builds + runs your code
 * from a GitHub repo. Distinct from the existing `digitalocean` provider
 * which manages droplets.
 *
 * Config shape:
 *   { apiToken: string, region?: string }
 *
 * apiToken is a DO Personal Access Token with `app:*` scopes.
 */
export class DOAppsProvider implements HostingProvider {
  readonly name = "digitalocean-apps" as const;

  validate(config: Record<string, unknown>): ProviderConfigCheck {
    const issues: string[] = [];
    if (typeof config["apiToken"] !== "string" || !config["apiToken"]) {
      issues.push("apiToken is required (DO PAT with app:create/read/update/delete scopes)");
    }
    if (config["region"] !== undefined && typeof config["region"] !== "string") {
      issues.push("region must be a string when provided");
    }
    return { ok: issues.length === 0, issues };
  }

  async verify(config: Record<string, unknown>): Promise<ProviderConfigCheck> {
    const base = this.validate(config);
    if (!base.ok) return base;
    try {
      const resp = await fetch("https://api.digitalocean.com/v2/apps?per_page=1", {
        headers: { Authorization: `Bearer ${config["apiToken"] as string}` },
      });
      if (!resp.ok) {
        return {
          ok: false,
          issues: [`DO Apps API returned ${String(resp.status)} — check token scopes`],
        };
      }
      return { ok: true, issues: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      return { ok: false, issues: [`DO Apps API unreachable: ${msg}`] };
    }
  }

  async provision(
    _config: Record<string, unknown>,
    _opts: { userId: string; name: string },
  ): Promise<ProvisionResult> {
    // No per-infra provisioning — apps are created per-deployment.
    return Promise.resolve({
      hostingNodeIp: "digitalocean-apps",
      hostingNodeId: "do-apps",
      hostingNodeLabel: "digitalocean-apps",
    });
  }

  async destroy(
    _config: Record<string, unknown>,
    _hostingNodeId: string,
  ): Promise<void> {
    return Promise.resolve();
  }
}
