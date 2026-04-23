import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  HostingProvider,
  ProviderConfigCheck,
  ProvisionResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Zero-setup local deploy target. Apps are built and run on the Docker
 * daemon AgentHub itself uses, via the `/var/run/docker.sock` bind mount
 * that's already declared in compose/docker-compose.yml behind the
 * `AGENTHUB_ALLOW_SOCKET_MOUNT=true` gate.
 *
 * Config shape: `{}` — no fields. The provider's existence is bound to
 * whether the socket is mounted + the daemon responds.
 *
 * Each deployment gets a host port assigned by the deployer (see
 * nextAvailableHostPort in deployer.ts) and a shareable URL of the shape
 * `http://<AGENTHUB_PUBLIC_HOST>:<port>`. No domain/TLS/DNS — users who
 * want HTTPS put Tailscale, Caddy, or Cloudflare Tunnel in front.
 */
export class LocalDockerProvider implements HostingProvider {
  readonly name = "local-docker" as const;

  validate(_config: Record<string, unknown>): ProviderConfigCheck {
    if (process.env["AGENTHUB_ALLOW_SOCKET_MOUNT"] !== "true") {
      return {
        ok: false,
        issues: [
          "Local Docker deploys require AGENTHUB_ALLOW_SOCKET_MOUNT=true in compose/.env. " +
            "Set it and restart the stack to enable this target.",
        ],
      };
    }
    return { ok: true, issues: [] };
  }

  async verify(config: Record<string, unknown>): Promise<ProviderConfigCheck> {
    const base = this.validate(config);
    if (!base.ok) return base;
    try {
      await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], {
        timeout: 5_000,
      });
      return { ok: true, issues: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        issues: [
          `docker socket unreachable: ${msg}. Verify /var/run/docker.sock is mounted into the server container.`,
        ],
      };
    }
  }

  async provision(
    _config: Record<string, unknown>,
    _opts: { userId: string; name: string },
  ): Promise<ProvisionResult> {
    // Nothing to provision — the "node" is the AgentHub host itself. Return a
    // synthetic identifier so the caller's provisioning flow has something
    // non-null to store.
    return Promise.resolve({
      hostingNodeIp: "127.0.0.1",
      hostingNodeId: "local-docker",
      hostingNodeLabel: "local",
    });
  }

  async destroy(
    _config: Record<string, unknown>,
    _hostingNodeId: string,
  ): Promise<void> {
    // Per-deployment cleanup happens in the deployer — nothing at the
    // provider level to tear down.
    return Promise.resolve();
  }
}
