/**
 * Provider interface for *inner MCP* deploy targets — i.e., where the agent
 * inside a workspace deploys the apps IT is building. Different from the
 * outer workspace provisioner (services/provisioner/*).
 *
 * An infra record in the DB maps to exactly one HostingProvider. The provider
 * is responsible for:
 *   - verifying config on create (so we fail fast with a helpful error)
 *   - provisioning a hosting node if one is needed (DigitalOcean: create
 *     droplet; Docker/Dokploy: no-op — user already has the host)
 *   - accepting deploy requests and routing them to either:
 *       a) SSH + docker-compose (docker, digitalocean), or
 *       b) Dokploy API (dokploy)
 */

export interface ProviderConfigCheck {
  ok: boolean;
  issues: string[];
}

export interface ProvisionResult {
  hostingNodeIp: string;
  /** Provider-specific identifier (droplet ID, VMID, compose app ID, etc.) */
  hostingNodeId: string;
  /** Opaque provider-specific region/node label. Optional. */
  hostingNodeLabel?: string;
}

export interface HostingProvider {
  readonly name: "docker" | "digitalocean" | "dokploy";

  /** Shallow validation of the config the user submitted. No network calls. */
  validate(config: Record<string, unknown>): ProviderConfigCheck;

  /** Probe the provider to confirm credentials work. Optional network call. */
  verify(config: Record<string, unknown>): Promise<ProviderConfigCheck>;

  /**
   * Create/prepare the underlying compute. For `docker` this is a no-op;
   * for `digitalocean` this creates the droplet; for `dokploy` we record the
   * URL as the hosting node and skip the SSH bootstrap.
   */
  provision(
    config: Record<string, unknown>,
    opts: { userId: string; name: string },
  ): Promise<ProvisionResult>;

  /** Tear down everything provision() created. Idempotent. */
  destroy(config: Record<string, unknown>, hostingNodeId: string): Promise<void>;
}

export class ProviderNotImplementedError extends Error {
  constructor(capability: string) {
    super(`${capability} is scaffolded but not yet wired end-to-end`);
    this.name = "ProviderNotImplementedError";
  }
}
