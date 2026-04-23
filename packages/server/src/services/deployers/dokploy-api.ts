import { DeployError } from "../deploy-error.js";

export interface DokployConfig {
  baseUrl: string;
  apiToken: string;
  projectId: string;
  environmentId: string;
  /** Optional externally-reachable host for this Dokploy instance. When
   * set it overrides the baseUrl-derived hostname for Cloudflare A records.
   * Added in PR #29 — older infra rows won't have it. */
  publicHost?: string;
}

/**
 * Shared tRPC-openapi call helper for Dokploy. Handles x-api-key auth,
 * JSON body encoding, and maps non-2xx responses to DeployError(502) with
 * the upstream body so operators see the real error instead of a generic
 * "deploy failed". All non-GET procedures POST; GET query-style procedures
 * use the `?param=...` form Dokploy's openapi handler exposes.
 */
export async function dokployRequest<T>(
  cfg: DokployConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiToken,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}${path}`, init);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new DeployError(
      `Dokploy ${method} ${path} failed (${String(resp.status)}): ${text}`,
      502,
    );
  }
  return (await resp.json()) as T;
}

/**
 * Validate + normalize a Dokploy infra config row merged with its
 * Infisical secret (apiToken). Throws DeployError(400) when any of the
 * required metadata fields is missing.
 */
export function resolveDokployConfig(merged: Record<string, unknown>): DokployConfig {
  const baseUrl = merged["baseUrl"] as string | undefined;
  const apiToken = merged["apiToken"] as string | undefined;
  const projectId = merged["projectId"] as string | undefined;
  const environmentId = merged["environmentId"] as string | undefined;
  if (!baseUrl || !apiToken || !projectId || !environmentId) {
    throw new DeployError(
      "Dokploy infra config missing one of: baseUrl, apiToken, projectId, environmentId",
    );
  }
  const cfg: DokployConfig = { baseUrl, apiToken, projectId, environmentId };
  const publicHost = merged["publicHost"];
  if (typeof publicHost === "string" && publicHost.trim()) {
    cfg.publicHost = publicHost.trim();
  }
  return cfg;
}

/**
 * Derive the externally-reachable host for this Dokploy instance. Priority:
 *   1. Explicit `publicHost` field on the infra config.
 *   2. Hostname parsed from `baseUrl` (e.g. `http://dokploy.example.com:3000`
 *      → `dokploy.example.com`, `http://192.168.5.50:3000` → `192.168.5.50`).
 *
 * Returns `{ host, source }` so callers can surface *why* they got the value
 * they did — useful in the `choose_domain` MCP prompt so the operator
 * can catch a LAN-ish fallback before committing DNS.
 */
export function resolvePublicHost(
  cfg: DokployConfig,
): { host: string; source: "explicit" | "baseUrl" } {
  if (cfg.publicHost) return { host: cfg.publicHost, source: "explicit" };
  try {
    const url = new URL(cfg.baseUrl);
    return { host: url.hostname, source: "baseUrl" };
  } catch {
    // baseUrl shouldn't be malformed at this point (resolveDokployConfig
    // would have passed it through as a string), but fall back to the
    // raw value rather than crashing.
    return { host: cfg.baseUrl, source: "baseUrl" };
  }
}

/** RFC 1918 / loopback / link-local — useful for warning about non-routable publicHosts. */
export function isLanOnlyHost(host: string): boolean {
  if (host === "localhost" || host.startsWith("127.")) return true;
  if (host.startsWith("10.")) return true;
  if (host.startsWith("192.168.")) return true;
  // 172.16.0.0 – 172.31.255.255
  const m = /^172\.(\d+)\./.exec(host);
  if (m?.[1]) {
    const n = parseInt(m[1], 10);
    if (n >= 16 && n <= 31) return true;
  }
  if (host.startsWith("169.254.")) return true;
  return false;
}
