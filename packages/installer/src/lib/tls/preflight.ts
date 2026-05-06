export interface PreflightResult {
  ok: boolean;
  reason?: string;
  skipped?: boolean;
}

/**
 * Verify the Cloudflare API token is valid AND has access to a zone matching
 * the install domain. Catches the most common DNS-01 misconfiguration before
 * we wait 90s for ACME to time out.
 *
 * domain="agenthub.example.com" matches a zone named "example.com" — we
 * progressively shorten the FQDN's leftmost label and check each as a zone.
 */
export async function preflightCloudflare(
  token: string,
  domain: string,
): Promise<PreflightResult> {
  const candidates: string[] = [];
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    candidates.push(parts.slice(i).join("."));
  }

  for (const zone of candidates) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(zone)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );
    const body = (await res.json()) as {
      success: boolean;
      result?: Array<{ name: string }>;
      errors?: Array<{ message: string }>;
    };
    if (!body.success) {
      const reason =
        body.errors?.map((e) => e.message).join(", ") ?? `HTTP ${res.status}`;
      return { ok: false, reason };
    }
    if ((body.result ?? []).length > 0) {
      return { ok: true };
    }
  }
  return {
    ok: false,
    reason: `no Cloudflare zone matching ${parts.slice(1).join(".")} or any parent — token may not have access to this zone, or zone isn't in this account`,
  };
}

/**
 * Dispatch pre-flight by provider. Non-Cloudflare providers skip — we don't
 * maintain provider-specific token checks for them (too varied). Falls
 * through to the loud-failure gate during install if their token is wrong.
 */
export async function preflightDns01(
  provider: string,
  domain: string,
  envVars: Record<string, string | undefined>,
): Promise<PreflightResult> {
  if (provider === "cloudflare") {
    const token = envVars["CF_DNS_API_TOKEN"];
    if (!token) {
      return {
        ok: false,
        reason: "preflightDns01: CF_DNS_API_TOKEN missing from envVars",
      };
    }
    return preflightCloudflare(token, domain);
  }
  return { ok: true, skipped: true };
}
