/**
 * Dokploy domain API wrappers. Dokploy's `domain` tRPC router attaches a
 * user-chosen hostname (+ TLS settings) to a compose or application so its
 * internal Traefik routes traffic there. Without this call, a deploy with
 * `input.domain` gets the compose running but no external access.
 *
 * Endpoint reference:
 *   POST /api/domain.create        — input: apiCreateDomain schema
 *   GET  /api/domain.byComposeId?composeId=<id>
 *   POST /api/domain.delete        — input: { domainId }
 *
 * Source of truth for the shapes:
 *   github.com/Dokploy/dokploy/blob/canary/apps/dokploy/server/api/routers/domain.ts
 *   github.com/Dokploy/dokploy/blob/canary/packages/server/src/db/schema/domain.ts
 */
import { DeployError } from "../deploy-error.js";
import { type DokployConfig, dokployRequest } from "./dokploy-api.js";

export type DokployCertificateType = "letsencrypt" | "none" | "custom";

export interface DokployDomain {
  domainId: string;
  host: string;
  port: number | null;
  path: string | null;
  serviceName: string | null;
  https: boolean;
  certificateType: DokployCertificateType;
  composeId: string | null;
  applicationId: string | null;
}

export interface CreateDokployDomainInput {
  composeId: string;
  host: string;
  /** Container port the domain forwards to (e.g. 80 for nginx, 3000 default). */
  port: number;
  /** Compose service the domain targets — required for multi-service composes,
   * recommended even for single-service so Dokploy routes unambiguously. */
  serviceName: string;
  /** URL path prefix. Default "/". */
  path?: string;
  /** Enable HTTPS via Dokploy's Traefik. Default true. */
  https?: boolean;
  /** Certificate issuer. Default "letsencrypt" (automatic ACME). */
  certificateType?: DokployCertificateType;
}

/** Register `input.host` with Dokploy so Traefik routes it to the compose. */
export async function createDokployDomain(
  cfg: DokployConfig,
  input: CreateDokployDomainInput,
): Promise<DokployDomain> {
  return dokployRequest<DokployDomain>(cfg, "POST", "/api/domain.create", {
    composeId: input.composeId,
    host: input.host,
    port: input.port,
    path: input.path ?? "/",
    serviceName: input.serviceName,
    https: input.https ?? true,
    certificateType: input.certificateType ?? "letsencrypt",
    domainType: "compose",
  });
}

/** All domain rows attached to this compose. Safe-empty on missing compose. */
export async function listDokployDomains(
  cfg: DokployConfig,
  composeId: string,
): Promise<DokployDomain[]> {
  return dokployRequest<DokployDomain[]>(
    cfg,
    "GET",
    `/api/domain.byComposeId?composeId=${encodeURIComponent(composeId)}`,
  );
}

/** Remove a single domain by its Dokploy-issued id. No-op if it doesn't exist. */
export async function deleteDokployDomain(
  cfg: DokployConfig,
  domainId: string,
): Promise<void> {
  try {
    await dokployRequest(cfg, "POST", "/api/domain.delete", { domainId });
  } catch (err) {
    if (err instanceof DeployError && /not found/i.test(err.message)) return;
    throw err;
  }
}

/**
 * Find an existing domain on `composeId` whose host matches `wanted`. Used
 * by the deploy path to detect idempotent re-registration and to look up
 * the old row when the user rotates to a new domain.
 */
export async function findDomainByHost(
  cfg: DokployConfig,
  composeId: string,
  wanted: string,
): Promise<DokployDomain | null> {
  const all = await listDokployDomains(cfg, composeId);
  const lc = wanted.toLowerCase();
  return all.find((d) => d.host.toLowerCase() === lc) ?? null;
}
