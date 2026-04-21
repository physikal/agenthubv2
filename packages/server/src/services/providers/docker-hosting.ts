import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  HostingProvider,
  ProviderConfigCheck,
  ProvisionResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * BYO-Docker host. User supplies:
 *   { hostIp: "1.2.3.4", sshUser?: "root", sshPrivateKey: "-----BEGIN ..." }
 * We verify SSH works + Docker is present. No droplet creation, no bootstrap —
 * the user is responsible for the host.
 *
 * For greenfield hosts that DON'T have Docker yet, `docker/hosting-template.sh`
 * can be scp'd and executed — call it via the `bootstrap` flag in the install
 * UI (Phase 9 / v2.1).
 */
export class DockerHostingProvider implements HostingProvider {
  readonly name = "docker" as const;

  validate(config: Record<string, unknown>): ProviderConfigCheck {
    const issues: string[] = [];
    if (typeof config["hostIp"] !== "string" || !config["hostIp"]) {
      issues.push("hostIp is required");
    }
    if (typeof config["sshPrivateKey"] !== "string" || !config["sshPrivateKey"]) {
      issues.push("sshPrivateKey is required");
    }
    return { ok: issues.length === 0, issues };
  }

  async verify(config: Record<string, unknown>): Promise<ProviderConfigCheck> {
    const base = this.validate(config);
    if (!base.ok) return base;

    const ip = config["hostIp"] as string;
    const sshUser = (config["sshUser"] as string | undefined) ?? "root";

    // Write key to a tempfile with restrictive perms, then ssh. We use
    // `BatchMode=yes` so ssh won't hang on a password prompt if the key
    // doesn't work.
    const { writeFileSync, chmodSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "agenthub-ssh-"));
    const keyPath = join(dir, "id_key");
    writeFileSync(keyPath, config["sshPrivateKey"] as string);
    chmodSync(keyPath, 0o600);

    try {
      await execFileAsync(
        "ssh",
        [
          "-i",
          keyPath,
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          "-o",
          "ConnectTimeout=10",
          `${sshUser}@${ip}`,
          "docker version --format '{{.Server.Version}}' && test -f /etc/hosts",
        ],
        { timeout: 20_000 },
      );
      return { ok: true, issues: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] ?? "ssh failed" : "ssh failed";
      return { ok: false, issues: [msg] };
    } finally {
      // Best-effort cleanup
      try {
        const { unlinkSync, rmdirSync } = await import("node:fs");
        unlinkSync(keyPath);
        rmdirSync(dir);
      } catch {
        // ignore
      }
    }
  }

  async provision(
    config: Record<string, unknown>,
    _opts: { userId: string; name: string },
  ): Promise<ProvisionResult> {
    const ip = config["hostIp"] as string;
    return Promise.resolve({
      hostingNodeIp: ip,
      hostingNodeId: `docker:${ip}`,
      hostingNodeLabel: "byo-docker",
    });
  }

  async destroy(
    _config: Record<string, unknown>,
    _hostingNodeId: string,
  ): Promise<void> {
    // Nothing to tear down — the user owns the host.
    return Promise.resolve();
  }
}
