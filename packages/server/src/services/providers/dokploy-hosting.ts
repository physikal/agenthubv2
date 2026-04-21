import type {
  HostingProvider,
  ProviderConfigCheck,
  ProvisionResult,
} from "./types.js";

/**
 * Dokploy deploy target (distinct from the outer-workspace Dokploy driver
 * in services/provisioner/dokploy.ts — this one is "agent deploys its app
 * to a Dokploy instance").
 *
 * Config shape:
 *   { baseUrl: "https://dokploy.example.com", apiToken: "...",
 *     projectId: "...", environmentId: "..." }
 *
 * No SSH bootstrap, no droplet — Dokploy owns the underlying host. When
 * deployer.ts needs to push an app, it calls POST /api/compose.create
 * against this baseUrl with the token. Deployment model matches the outer
 * driver, so we reuse most of the REST surface.
 */
export class DokployHostingProvider implements HostingProvider {
  readonly name = "dokploy" as const;

  validate(config: Record<string, unknown>): ProviderConfigCheck {
    const issues: string[] = [];
    for (const key of ["baseUrl", "apiToken", "projectId", "environmentId"] as const) {
      if (typeof config[key] !== "string" || !config[key]) {
        issues.push(`${key} is required`);
      }
    }
    if (
      typeof config["baseUrl"] === "string" &&
      !/^https?:\/\//.test(config["baseUrl"])
    ) {
      issues.push("baseUrl must start with http:// or https://");
    }
    return { ok: issues.length === 0, issues };
  }

  async verify(config: Record<string, unknown>): Promise<ProviderConfigCheck> {
    const base = this.validate(config);
    if (!base.ok) return base;

    try {
      const resp = await fetch(
        `${(config["baseUrl"] as string).replace(/\/$/, "")}/api/auth.me`,
        {
          headers: { Authorization: `Bearer ${config["apiToken"] as string}` },
        },
      );
      if (!resp.ok) {
        return {
          ok: false,
          issues: [`Dokploy API returned ${String(resp.status)} — check URL and token`],
        };
      }
      return { ok: true, issues: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      return { ok: false, issues: [`Dokploy API unreachable: ${msg}`] };
    }
  }

  async provision(
    config: Record<string, unknown>,
    _opts: { userId: string; name: string },
  ): Promise<ProvisionResult> {
    // Dokploy owns the underlying host — "provision" is really just recording
    // the URL as our notion of a hosting node. Deployment happens later via
    // the Dokploy API in deployer.ts.
    return Promise.resolve({
      hostingNodeIp: config["baseUrl"] as string,
      hostingNodeId: `dokploy:${config["projectId"] as string}`,
      hostingNodeLabel: "dokploy",
    });
  }

  async destroy(
    _config: Record<string, unknown>,
    _hostingNodeId: string,
  ): Promise<void> {
    // Dokploy-level tear-down is the user's responsibility via Dokploy UI —
    // we don't drop their Dokploy project out from under them even on infra
    // deletion. deployer.ts already purges individual deploy compose apps.
    return Promise.resolve();
  }
}
