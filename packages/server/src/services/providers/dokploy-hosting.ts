import type {
  HostingProvider,
  ProviderConfigCheck,
  ProvisionResult,
} from "./types.js";

/**
 * Dokploy's trpc-openapi handler returns procedures either bare or wrapped
 * in the tRPC envelope {result:{data:<value>}}. Callers want the value.
 */
function unwrapTrpc(body: unknown): unknown {
  if (body && typeof body === "object" && "result" in body) {
    const result = (body as { result?: { data?: unknown } }).result;
    if (result && typeof result === "object" && "data" in result) {
      return result.data;
    }
  }
  return body;
}

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

    const baseUrl = (config["baseUrl"] as string).replace(/\/$/, "");
    const apiToken = config["apiToken"] as string;
    const projectId = config["projectId"] as string;
    const environmentId = config["environmentId"] as string;
    const headers = { "x-api-key": apiToken } as const;

    // Two-call probe. Dokploy has no dedicated "whoami" for x-api-key callers
    // (auth.me is a better-auth session endpoint — 404 for api-key users), so
    // we validate the token against a known tRPC query and then dereference
    // the env ID to confirm it exists and belongs to this key's org.
    //
    // 1. project.all → token authenticates
    // 2. environment.one?environmentId=... → env exists + in caller's org,
    //    and its returned project.projectId matches the configured one.
    try {
      const tokenProbe = await fetch(`${baseUrl}/api/project.all`, { headers });
      if (tokenProbe.status === 401) {
        return { ok: false, issues: ["Dokploy API token rejected — check apiToken"] };
      }
      if (!tokenProbe.ok) {
        return {
          ok: false,
          issues: [
            `Dokploy /api/project.all returned ${String(tokenProbe.status)} — check baseUrl`,
          ],
        };
      }

      const envResp = await fetch(
        `${baseUrl}/api/environment.one?environmentId=${encodeURIComponent(environmentId)}`,
        { headers },
      );
      if (envResp.status === 403) {
        return {
          ok: false,
          issues: [
            `environmentId "${environmentId}" belongs to a different Dokploy organization than this token`,
          ],
        };
      }
      if (envResp.status === 500 || envResp.status === 404) {
        return {
          ok: false,
          issues: [`environmentId "${environmentId}" not found in Dokploy`],
        };
      }
      if (!envResp.ok) {
        return {
          ok: false,
          issues: [
            `Dokploy /api/environment.one returned ${String(envResp.status)}`,
          ],
        };
      }

      // tRPC openapi shape: { result: { data: <env> } } — also occasionally
      // envelope-less. Accept either.
      const envBody = (await envResp.json().catch(() => null)) as unknown;
      const env = unwrapTrpc(envBody) as { project?: { projectId?: string } } | null;
      const observedProjectId = env?.project?.projectId;
      if (observedProjectId && observedProjectId !== projectId) {
        return {
          ok: false,
          issues: [
            `environmentId "${environmentId}" belongs to project "${observedProjectId}", not configured projectId "${projectId}"`,
          ],
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
