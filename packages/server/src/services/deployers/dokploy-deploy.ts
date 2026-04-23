import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import yaml from "js-yaml";
import { db, schema } from "../../db/index.js";
import type { InfrastructureConfig } from "../../db/schema.js";
import { DeployError } from "../deploy-error.js";
import { resolveInfraConfig } from "../secrets/helpers.js";
import {
  dokployRequest,
  isLanOnlyHost,
  resolveDokployConfig,
  resolvePublicHost,
} from "./dokploy-api.js";
import {
  createDokployDomain,
  deleteDokployDomain,
  findDomainByHost,
} from "./dokploy-domain.js";
import {
  deleteCloudflareDns,
  domainCoveredByZone,
  lookupZoneName,
  upsertCloudflareDns,
} from "../dns/cloudflare.js";

/**
 * Dokploy-backed deploy path. Mirrors the public API of deployer.ts but
 * uses Dokploy's compose API instead of SSH + docker-compose.
 *
 * Config (from infra.config + Infisical secrets):
 *   { baseUrl, apiToken, projectId, environmentId }
 */

export interface DokployDeployInput {
  userId: string;
  infraId: string;
  name: string;
  domain?: string | undefined;
  composeConfig?: string | undefined;
  composePath?: string | undefined;
  /** HTTPS Git URL. When present, Dokploy clones + builds from Git
   * instead of deploying an inline compose file. Mutually exclusive
   * with composeConfig. */
  gitUrl?: string | undefined;
  /** Branch to clone. Defaults to "main". */
  gitBranch?: string | undefined;
  envVars?: Record<string, string> | undefined;
  existingDeployId?: string | undefined;
}

export interface DokployDeployResult {
  id: string;
  url: string | null;
}

interface DokployCompose {
  composeId: string;
  appName: string;
  composeType: string;
  applicationStatus: string;
}

// DokployConfig, dokployRequest, resolveDokployConfig live in ./dokploy-api.js
// so the new domain module (./dokploy-domain.js) can share them without
// importing anything deploy-specific.

interface ComposeDocForDomain {
  services?: Record<string, {
    ports?: Array<string | { target?: number; published?: number | string }>;
    expose?: Array<string | number>;
  }>;
}

/**
 * Given a docker-compose YAML string, return the first service that publishes
 * or exposes a TCP port, alongside that container-side port. Used to wire
 * Dokploy's `domain.create` call — Dokploy's Traefik forwards to the
 * container's target port, not the host-side published port.
 *
 * Returns null when the compose has no services or none expose a port.
 */
export function firstServicePortForDomain(
  composeText: string,
): { serviceName: string; containerPort: number } | null {
  let doc: ComposeDocForDomain;
  try {
    doc = (yaml.load(composeText) ?? {}) as ComposeDocForDomain;
  } catch {
    return null;
  }
  const services = doc.services ?? {};
  for (const [serviceName, svc] of Object.entries(services)) {
    for (const entry of svc.ports ?? []) {
      const n = extractContainerPort(entry);
      if (n !== null) return { serviceName, containerPort: n };
    }
    for (const entry of svc.expose ?? []) {
      const n = typeof entry === "number" ? entry : parseInt(String(entry), 10);
      if (Number.isFinite(n) && n > 0 && n < 65536) {
        return { serviceName, containerPort: n };
      }
    }
  }
  return null;
}

function extractContainerPort(
  entry: string | { target?: number; published?: number | string },
): number | null {
  if (typeof entry === "string") {
    const slashIdx = entry.lastIndexOf("/");
    const proto = slashIdx !== -1 ? entry.slice(slashIdx + 1).toLowerCase() : "tcp";
    if (proto !== "tcp") return null;
    const spec = slashIdx !== -1 ? entry.slice(0, slashIdx) : entry;
    const parts = spec.split(":");
    // Last segment is the container port: "80" | "host:80" | "ip:host:80".
    const container = parts[parts.length - 1];
    if (!container) return null;
    const rangeStart = container.split("-")[0];
    if (!rangeStart) return null;
    const n = parseInt(rangeStart, 10);
    return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
  }
  if (typeof entry === "object" && entry !== null && entry.target !== undefined) {
    const n = typeof entry.target === "number" ? entry.target : parseInt(String(entry.target), 10);
    return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
  }
  return null;
}

/**
 * Best-effort Cloudflare DNS wiring. On success returns a short human string
 * describing what changed; on failure returns a reason string so the
 * caller can surface it to the operator without failing the deploy.
 * Dokploy domain registration is the authoritative step — CF is downstream.
 */
async function upsertCfRecordForDomain(
  userId: string,
  domain: string,
  ip: string,
): Promise<{ applied: true; note: string } | { applied: false; reason: string }> {
  const cfInfras = db
    .select()
    .from(schema.infrastructureConfigs)
    .where(
      and(
        eq(schema.infrastructureConfigs.userId, userId),
        eq(schema.infrastructureConfigs.provider, "cloudflare"),
      ),
    )
    .all();
  const cfInfra = cfInfras[0];
  if (!cfInfra) {
    return {
      applied: false,
      reason: `no Cloudflare integration — add A record ${domain} → ${ip} manually`,
    };
  }
  const cfResolved = await resolveInfraConfig(
    userId,
    cfInfra.id,
    JSON.parse(cfInfra.config) as Record<string, unknown>,
  );
  const cfToken = cfResolved["apiToken"];
  const cfZoneId = cfResolved["zoneId"];
  if (typeof cfToken !== "string" || typeof cfZoneId !== "string") {
    return {
      applied: false,
      reason: `Cloudflare integration "${cfInfra.name}" missing apiToken or zoneId — add A record ${domain} → ${ip} manually`,
    };
  }
  let zoneName: string;
  try {
    zoneName = await lookupZoneName(cfToken, cfZoneId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return {
      applied: false,
      reason: `Cloudflare zone lookup failed (${msg}) — add A record ${domain} → ${ip} manually`,
    };
  }
  if (!domainCoveredByZone(domain, zoneName)) {
    return {
      applied: false,
      reason: `domain "${domain}" outside Cloudflare zone "${zoneName}" — add A record ${domain} → ${ip} manually`,
    };
  }
  try {
    const verb = await upsertCloudflareDns(cfToken, cfZoneId, domain, ip);
    return { applied: true, note: `Cloudflare A record ${verb}: ${domain} → ${ip}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return {
      applied: false,
      reason: `Cloudflare write failed (${msg}) — add A record ${domain} → ${ip} manually`,
    };
  }
}

async function deleteCfRecordForDomain(
  userId: string,
  domain: string,
): Promise<void> {
  const cfInfras = db
    .select()
    .from(schema.infrastructureConfigs)
    .where(
      and(
        eq(schema.infrastructureConfigs.userId, userId),
        eq(schema.infrastructureConfigs.provider, "cloudflare"),
      ),
    )
    .all();
  const cfInfra = cfInfras[0];
  if (!cfInfra) return;
  const cfResolved = await resolveInfraConfig(
    userId,
    cfInfra.id,
    JSON.parse(cfInfra.config) as Record<string, unknown>,
  );
  const cfToken = cfResolved["apiToken"];
  const cfZoneId = cfResolved["zoneId"];
  if (typeof cfToken !== "string" || typeof cfZoneId !== "string") return;
  try {
    await deleteCloudflareDns(cfToken, cfZoneId, domain);
  } catch {
    // Best-effort: destroy-path errors shouldn't block cleanup.
  }
}

/**
 * Create a Dokploy compose app for this deployment. Returns the deployment
 * row shape the caller persists in `deployments`.
 */
export async function dokployDeploy(
  infra: InfrastructureConfig,
  resolvedConfig: Record<string, unknown>,
  input: DokployDeployInput,
): Promise<DokployDeployResult> {
  const cfg = resolveDokployConfig(resolvedConfig);

  const appName = `agenthub-${input.name}-${randomUUID().slice(0, 8)}`.toLowerCase();
  const deployId = input.existingDeployId ?? randomUUID();
  // Two modes:
  //   git_url: Dokploy clones + builds from the caller's git remote. Dokploy
  //     reads docker-compose.yml (or `composePath`) from the repo. Used for
  //     both source_path (auto-converted upstream in deployer.ts) and
  //     explicit gitUrl input.
  //   composeConfig: caller supplied a verbatim docker-compose.yml — typically
  //     for pre-built images like n8n. Dokploy runs it as-is.
  const useGit = Boolean(input.gitUrl);
  if (!useGit && !input.composeConfig) {
    throw new DeployError(
      "Dokploy deploy requires either a git URL (derived from source_path or passed explicitly) or composeConfig",
    );
  }
  const composeYaml = useGit ? "" : (input.composeConfig as string);
  const gitBranch = input.gitBranch ?? "main";

  let composeId: string;
  if (input.existingDeployId) {
    const row = db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, input.existingDeployId))
      .get();
    if (!row?.containerId) {
      throw new Error(
        `Update requested for ${input.existingDeployId} but no Dokploy composeId stored`,
      );
    }
    composeId = row.containerId;
  } else {
    const created = await dokployRequest<DokployCompose>(
      cfg,
      "POST",
      "/api/compose.create",
      {
        name: input.name,
        appName,
        environmentId: cfg.environmentId,
        description: `AgentHub deploy for user ${input.userId}`,
      },
    );
    composeId = created.composeId;
  }

  // Switch Dokploy's sourceType based on what the caller gave us.
  //  - git: Dokploy clones `customGitUrl`@`customGitBranch` and uses the
  //    `docker-compose.yml` at the repo root (or `composePath` if given).
  //  - raw: We hand Dokploy a verbatim compose YAML string.
  if (useGit) {
    await dokployRequest(cfg, "POST", "/api/compose.update", {
      composeId,
      composeType: "docker-compose",
      sourceType: "git",
      customGitUrl: input.gitUrl,
      customGitBranch: gitBranch,
      ...(input.composePath ? { composePath: input.composePath } : {}),
    });
  } else {
    // Dokploy's `composeType` enum is {"docker-compose", "stack"}; "raw"
    // only ever belonged on `sourceType` (which distinguishes inline-YAML
    // from git clones). Earlier versions silently accepted the mismatch;
    // current canonical API rejects it with a 400 zodError.
    await dokployRequest(cfg, "POST", "/api/compose.update", {
      composeId,
      composeType: "docker-compose",
      sourceType: "raw",
      composeFile: composeYaml,
    });
  }

  await dokployRequest(cfg, "POST", "/api/compose.deploy", {
    composeId,
    title: input.existingDeployId ? "update" : "initial deploy",
    description: input.name,
  });

  // Domain registration + DNS wiring. Only runs when the caller supplied
  // `input.domain` AND the stored domain (if this is an update) differs.
  // On a domain rotation, cull the old Dokploy domain entry + CF record so
  // we don't leak either.
  let statusDetail: string | null = null;
  if (input.domain) {
    const prevDomain = input.existingDeployId
      ? (
          db
            .select({ d: schema.deployments.domain })
            .from(schema.deployments)
            .where(eq(schema.deployments.id, input.existingDeployId))
            .get()?.d ?? null
        )
      : null;
    if (prevDomain && prevDomain !== input.domain) {
      const oldRow = await findDomainByHost(cfg, composeId, prevDomain);
      if (oldRow) {
        await deleteDokployDomain(cfg, oldRow.domainId);
      }
      await deleteCfRecordForDomain(input.userId, prevDomain);
    }

    // Source of truth for service + port is the compose YAML for raw-mode
    // deploys, and the user's repo-side compose for git-mode (we don't
    // fetch it here; require the caller to specify if they want git-mode
    // domains in a future iteration — the MVP covers raw + rebuilds).
    const composeSource = useGit ? null : composeYaml;
    if (!composeSource) {
      throw new DeployError(
        "Dokploy git-url deploys with a domain aren't yet supported — Dokploy's compose lives in the repo; pass composeConfig or add the domain in Dokploy's UI",
      );
    }
    const svc = firstServicePortForDomain(composeSource);
    if (!svc) {
      throw new DeployError(
        "could not derive a service + port from composeConfig for Dokploy domain routing — ensure the first service has a `ports:` or `expose:` entry",
      );
    }

    // Reuse existing domain row if we're redeploying the same host — Dokploy
    // otherwise returns a duplicate-host error.
    const existingDomain = await findDomainByHost(cfg, composeId, input.domain);
    if (!existingDomain) {
      await createDokployDomain(cfg, {
        composeId,
        host: input.domain,
        port: svc.containerPort,
        serviceName: svc.serviceName,
      });
    }

    const { host: publicHost } = resolvePublicHost(cfg);
    const cfResult = await upsertCfRecordForDomain(input.userId, input.domain, publicHost);
    const parts: string[] = [];
    if (cfResult.applied) {
      parts.push(cfResult.note);
    } else {
      parts.push(`DNS not auto-wired: ${cfResult.reason}`);
    }
    if (isLanOnlyHost(publicHost)) {
      parts.push(
        `Note: publicHost=${publicHost} looks LAN-only — set publicHost on the Dokploy integration to a routable address.`,
      );
    }
    statusDetail = parts.join(" ");
  }

  const url = input.domain ? `https://${input.domain}` : null;

  const now = new Date();
  if (input.existingDeployId) {
    db.update(schema.deployments)
      .set({
        status: "running",
        statusDetail,
        url,
        domain: input.domain ?? null,
        composeConfig: useGit ? null : composeYaml,
        gitUrl: input.gitUrl ?? null,
        gitBranch: useGit ? gitBranch : null,
        buildStrategy: useGit ? "git-pull" : "compose-inline",
        updatedAt: now,
      })
      .where(eq(schema.deployments.id, input.existingDeployId))
      .run();
  } else {
    db.insert(schema.deployments)
      .values({
        id: deployId,
        userId: input.userId,
        infraId: infra.id,
        name: input.name,
        domain: input.domain ?? null,
        internalOnly: false,
        status: "running",
        statusDetail,
        url,
        containerId: composeId, // store Dokploy composeId here for later ops
        composeConfig: useGit ? null : composeYaml,
        gitUrl: input.gitUrl ?? null,
        gitBranch: useGit ? gitBranch : null,
        buildStrategy: useGit ? "git-pull" : "compose-inline",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  return { id: deployId, url };
}

export async function dokployLogs(
  resolvedConfig: Record<string, unknown>,
  composeId: string,
  lines: number,
): Promise<string> {
  const cfg = resolveDokployConfig(resolvedConfig);
  const resp = await fetch(
    `${cfg.baseUrl.replace(/\/$/, "")}/api/compose.logs?composeId=${encodeURIComponent(composeId)}&tail=${String(lines)}`,
    { headers: { "x-api-key": cfg.apiToken } },
  );
  if (!resp.ok) {
    throw new Error(`Dokploy logs fetch failed (${String(resp.status)})`);
  }
  return resp.text();
}

export async function dokployRestart(
  resolvedConfig: Record<string, unknown>,
  composeId: string,
): Promise<void> {
  const cfg = resolveDokployConfig(resolvedConfig);
  await dokployRequest(cfg, "POST", "/api/compose.deploy", {
    composeId,
    title: "restart",
    description: "manual restart via AgentHub",
  });
}

export async function dokployDestroy(
  resolvedConfig: Record<string, unknown>,
  composeId: string,
  opts: { userId?: string; domain?: string | null } = {},
): Promise<void> {
  const cfg = resolveDokployConfig(resolvedConfig);
  // Best-effort: remove the Cloudflare A record (if any) before the Dokploy
  // compose goes away so we don't leave stale DNS pointing at a deleted
  // app. Domain rows on Dokploy itself are cascade-deleted with the compose.
  if (opts.userId && opts.domain) {
    await deleteCfRecordForDomain(opts.userId, opts.domain);
  }
  await dokployRequest(cfg, "POST", "/api/compose.delete", {
    composeId,
    deleteVolumes: true,
  });
}
