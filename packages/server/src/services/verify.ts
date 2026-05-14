/**
 * Credential probes for non-HostingProvider integrations.
 *
 * The `/api/infra/:id/verify` route uses these to actually exercise stored
 * credentials against the upstream provider — until 2026-05-14 it returned
 * `{ok:true}` without probing, which let bad keys masquerade as verified.
 *
 * Each probe returns ProviderConfigCheck — `{ok, issues[]}` — so the route
 * handler can fold them in alongside the HostingProvider .verify() results.
 *
 * Network failures are treated as "verify failed, not crashed": we report
 * `ok:false` with a human-readable issue rather than throwing, because the
 * UI shows the issues list directly. The route never sees an exception.
 */
import type { ProviderConfigCheck } from "./providers/types.js";

const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com";
const OPENAI_DEFAULT_BASE = "https://api.openai.com";
const MINIMAX_DEFAULT_BASE = "https://api.minimax.io/anthropic";
const B2_AUTH_URL = "https://api.backblazeb2.com/b2api/v3/b2_authorize_account";
const CF_API = "https://api.cloudflare.com/client/v4";
const VERIFY_TIMEOUT_MS = 10_000;

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = VERIFY_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function networkIssue(name: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(msg)) return `${name} timed out after ${VERIFY_TIMEOUT_MS / 1000}s`;
  return `${name} unreachable: ${msg}`;
}

export async function verifyAnthropicKey(
  apiKey: string,
  baseUrl?: string,
): Promise<ProviderConfigCheck> {
  const base = trimSlash(baseUrl || ANTHROPIC_DEFAULT_BASE);
  try {
    // GET /v1/models requires auth, returns 401 on bad key, 200 on good key.
    // Free (no token billing) + no model-name coupling vs /v1/messages.
    const resp = await fetchWithTimeout(`${base}/v1/models`, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, issues: ["apiKey rejected (401/403) — check the value"] };
    }
    if (resp.status === 429) {
      // Rate-limited still proves the key authenticates.
      return { ok: true, issues: [] };
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, issues: [`Anthropic API ${resp.status}: ${body.slice(0, 200)}`] };
    }
    return { ok: true, issues: [] };
  } catch (err) {
    return { ok: false, issues: [networkIssue("Anthropic API", err)] };
  }
}

export async function verifyOpenAIKey(
  apiKey: string,
  baseUrl?: string,
): Promise<ProviderConfigCheck> {
  const base = trimSlash(baseUrl || OPENAI_DEFAULT_BASE);
  try {
    // /v1/models is free, returns 401 on bad key, 200 on good key.
    const resp = await fetchWithTimeout(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, issues: ["apiKey rejected (401/403) — check the value"] };
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, issues: [`OpenAI API ${resp.status}: ${body.slice(0, 200)}`] };
    }
    return { ok: true, issues: [] };
  } catch (err) {
    return { ok: false, issues: [networkIssue("OpenAI API", err)] };
  }
}

export async function verifyMinimaxKey(
  apiKey: string,
  baseUrl?: string,
): Promise<ProviderConfigCheck> {
  // MiniMax exposes an Anthropic-compatible /v1/messages on /anthropic, which
  // is exactly what the bundled `claude-minimax` wrapper hits. We probe the
  // same endpoint so verify ↔ runtime stay aligned.
  const base = trimSlash(baseUrl || MINIMAX_DEFAULT_BASE);
  try {
    const resp = await fetchWithTimeout(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "MiniMax-M1",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, issues: ["apiKey rejected (401/403) — check the value"] };
    }
    if (resp.status === 429) {
      return { ok: true, issues: [] };
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, issues: [`MiniMax API ${resp.status}: ${body.slice(0, 200)}`] };
    }
    return { ok: true, issues: [] };
  } catch (err) {
    return { ok: false, issues: [networkIssue("MiniMax API", err)] };
  }
}

export async function verifyCloudflare(
  apiToken: string,
  zoneId: string,
): Promise<ProviderConfigCheck> {
  try {
    // Fetches the zone by ID — validates token + zone in one call.
    const resp = await fetchWithTimeout(
      `${CF_API}/zones/${encodeURIComponent(zoneId)}`,
      { headers: { Authorization: `Bearer ${apiToken}` } },
    );
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, issues: ["apiToken rejected — check the token's zone scope"] };
    }
    if (resp.status === 404) {
      return { ok: false, issues: [`zoneId ${zoneId} not found — check the ID`] };
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, issues: [`Cloudflare API ${resp.status}: ${body.slice(0, 200)}`] };
    }
    return { ok: true, issues: [] };
  } catch (err) {
    return { ok: false, issues: [networkIssue("Cloudflare API", err)] };
  }
}

export async function verifyB2(
  keyId: string,
  appKey: string,
  bucket: string,
): Promise<ProviderConfigCheck> {
  try {
    // b2_authorize_account validates the (keyId, appKey) pair and returns
    // the set of allowed buckets — we check that `bucket` is in that set.
    const auth = Buffer.from(`${keyId}:${appKey}`).toString("base64");
    const resp = await fetchWithTimeout(B2_AUTH_URL, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (resp.status === 401) {
      return { ok: false, issues: ["B2 keyId/appKey rejected (401) — check both fields"] };
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, issues: [`B2 auth ${resp.status}: ${body.slice(0, 200)}`] };
    }
    const body = (await resp.json()) as {
      apiInfo?: {
        storageApi?: {
          bucketId?: string | null;
          bucketName?: string | null;
        };
      };
    };
    const allowedBucket = body.apiInfo?.storageApi?.bucketName ?? null;
    // Application keys may be unrestricted (allowedBucket === null) or scoped
    // to a single bucket. If scoped, it must match.
    if (allowedBucket && allowedBucket !== bucket) {
      return {
        ok: false,
        issues: [
          `B2 key is scoped to bucket "${allowedBucket}" but config asks for "${bucket}"`,
        ],
      };
    }
    return { ok: true, issues: [] };
  } catch (err) {
    return { ok: false, issues: [networkIssue("B2 API", err)] };
  }
}

export async function verifyGitHubPatProbe(pat: string): Promise<ProviderConfigCheck> {
  try {
    const resp = await fetchWithTimeout("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, issues: ["pat rejected — check token + required scopes"] };
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, issues: [`GitHub API ${resp.status}: ${body.slice(0, 200)}`] };
    }
    return { ok: true, issues: [] };
  } catch (err) {
    return { ok: false, issues: [networkIssue("GitHub API", err)] };
  }
}

/**
 * Dispatch for the /verify route. Returns null when the provider is a regular
 * HostingProvider and the caller should fall back to provider.verify(). For
 * the non-HostingProvider integrations (cloudflare/b2/github/ai-*) we own the
 * probe inline.
 */
export async function verifyNonHostingCredentials(
  provider: string,
  config: Record<string, unknown>,
): Promise<ProviderConfigCheck | null> {
  const str = (k: string): string =>
    typeof config[k] === "string" ? (config[k] as string) : "";
  switch (provider) {
    case "cloudflare":
      return verifyCloudflare(str("apiToken"), str("zoneId"));
    case "b2":
      return verifyB2(str("b2KeyId"), str("b2AppKey"), str("b2Bucket"));
    case "github":
      return verifyGitHubPatProbe(str("pat"));
    case "ai-anthropic":
      return verifyAnthropicKey(str("apiKey"), str("baseUrl") || undefined);
    case "ai-openai":
      return verifyOpenAIKey(str("apiKey"), str("baseUrl") || undefined);
    case "ai-minimax":
      return verifyMinimaxKey(str("apiKey"), str("baseUrl") || undefined);
    default:
      return null;
  }
}
