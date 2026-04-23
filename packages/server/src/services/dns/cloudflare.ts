/**
 * Thin wrappers over Cloudflare's zone + DNS-records API. Shared by every
 * deploy path that wants to register a domain: legacy SSH, Dokploy, future
 * providers. We only do the things AgentHub needs — create, upsert, delete
 * an A record + look up a zone's canonical name — not a full SDK.
 *
 * Error policy: upstream non-2xx throws DeployError(502) with the body so
 * callers / the HTTP route can surface the exact Cloudflare message to the
 * operator. Scope / input bugs throw DeployError(400).
 */
import { DeployError } from "../deploy-error.js";

const CF_API = "https://api.cloudflare.com/client/v4";

interface CfListResponse<T> {
  success?: boolean;
  result?: T[];
  errors?: { message?: string }[];
}
interface CfSingleResponse<T> {
  success?: boolean;
  result?: T;
  errors?: { message?: string }[];
}

interface CfDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
}

interface CfZone {
  id: string;
  name: string;
}

async function cfFetch(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  return fetch(`${CF_API}${path}`, { ...init, headers });
}

async function readCfError(resp: Response): Promise<string> {
  const body = await resp.text().catch(() => "");
  return body || `HTTP ${String(resp.status)}`;
}

/**
 * Return the canonical zone name for a given zone ID (e.g. "example.com").
 * Used to gate whether the caller's chosen domain falls under the token's
 * authorized zone before we attempt a write.
 */
export async function lookupZoneName(token: string, zoneId: string): Promise<string> {
  const resp = await cfFetch(`/zones/${encodeURIComponent(zoneId)}`, token);
  if (!resp.ok) {
    throw new DeployError(
      `Cloudflare /zones/${zoneId} failed: ${await readCfError(resp)}`,
      502,
    );
  }
  const body = (await resp.json()) as CfSingleResponse<CfZone>;
  const name = body.result?.name;
  if (!name) {
    throw new DeployError(
      `Cloudflare returned no zone name for zoneId=${zoneId} — check that the configured zoneId is valid`,
      400,
    );
  }
  return name;
}

/**
 * Create or update an A record for `domain` pointing at `ip`. Idempotent:
 *   - missing → POST (create)
 *   - same IP → no-op
 *   - different IP → PATCH to the new IP
 *
 * Returns a verb describing what happened so callers can log meaningfully.
 */
export async function upsertCloudflareDns(
  token: string,
  zoneId: string,
  domain: string,
  ip: string,
): Promise<"created" | "unchanged" | "updated"> {
  const listResp = await cfFetch(
    `/zones/${encodeURIComponent(zoneId)}/dns_records?type=A&name=${encodeURIComponent(domain)}`,
    token,
  );
  if (!listResp.ok) {
    throw new DeployError(
      `Cloudflare list A records for ${domain} failed: ${await readCfError(listResp)}`,
      502,
    );
  }
  const list = (await listResp.json()) as CfListResponse<CfDnsRecord>;
  const existing = (list.result ?? []).find((r) => r.name === domain && r.type === "A");

  if (!existing) {
    const createResp = await cfFetch(
      `/zones/${encodeURIComponent(zoneId)}/dns_records`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          type: "A",
          name: domain,
          content: ip,
          proxied: false,
          ttl: 300,
        }),
      },
    );
    if (!createResp.ok) {
      throw new DeployError(
        `Cloudflare create A ${domain} → ${ip} failed: ${await readCfError(createResp)}`,
        502,
      );
    }
    return "created";
  }

  if (existing.content === ip) return "unchanged";

  const patchResp = await cfFetch(
    `/zones/${encodeURIComponent(zoneId)}/dns_records/${existing.id}`,
    token,
    {
      method: "PATCH",
      body: JSON.stringify({ content: ip }),
    },
  );
  if (!patchResp.ok) {
    throw new DeployError(
      `Cloudflare update A ${domain} → ${ip} failed: ${await readCfError(patchResp)}`,
      502,
    );
  }
  return "updated";
}

/**
 * Create an A record outright, failing on duplicates. Preserved for the
 * legacy SSH deploy path which relies on the sequencing (DNS create always
 * follows fresh hostname assignment). Prefer `upsertCloudflareDns` for new
 * call sites.
 */
export async function createCloudflareDns(
  token: string,
  zoneId: string,
  domain: string,
  ip: string,
): Promise<void> {
  const resp = await cfFetch(
    `/zones/${encodeURIComponent(zoneId)}/dns_records`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        type: "A",
        name: domain,
        content: ip,
        proxied: false,
        ttl: 300,
      }),
    },
  );
  if (!resp.ok) {
    throw new DeployError(
      `Cloudflare DNS creation failed: ${await readCfError(resp)}`,
      502,
    );
  }
}

/**
 * Delete every A record matching `domain` in the zone. Safe to call when
 * nothing exists — returns silently.
 */
export async function deleteCloudflareDns(
  token: string,
  zoneId: string,
  domain: string,
): Promise<void> {
  const listResp = await cfFetch(
    `/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(domain)}`,
    token,
  );
  if (!listResp.ok) return;
  const body = (await listResp.json()) as CfListResponse<CfDnsRecord>;
  for (const record of body.result ?? []) {
    if (record.name === domain) {
      await cfFetch(
        `/zones/${encodeURIComponent(zoneId)}/dns_records/${record.id}`,
        token,
        { method: "DELETE" },
      );
    }
  }
}

/**
 * True when `domain` is the zone itself or a subdomain of it. Used to
 * decide whether the caller's chosen hostname falls inside the token's
 * authorized zone before attempting a write.
 */
export function domainCoveredByZone(domain: string, zoneName: string): boolean {
  const d = domain.toLowerCase();
  const z = zoneName.toLowerCase();
  return d === z || d.endsWith(`.${z}`);
}
