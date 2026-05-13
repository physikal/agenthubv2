// ---- TLS admin (Plan 4) -------------------------------------------------

export interface TlsReconfigureRequest {
  mode: "public-alpn" | "dns-01" | "self-ca";
  tlsEmail?: string;
  dnsProvider?: string;
  dnsEnvVars?: Record<string, string>;
  lanIp?: string;
  noRollback?: boolean;
  regenCert?: boolean;
}

/**
 * Open an SSE stream against /api/admin/tls/reconfigure. Yields events as
 * the server emits them. Caller closes via the AbortController on the
 * optional `signal` arg.
 */
export async function* streamTlsReconfigure(
  req: TlsReconfigureRequest,
  signal?: AbortSignal,
): AsyncIterable<{ event: string; data: string }> {
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    credentials: "include",
  };
  if (signal) init.signal = signal;
  const res = await fetch("/api/admin/tls/reconfigure", init);
  if (!res.body) throw new Error("no SSE body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "log";
      const data = lines
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      yield { event, data };
    }
  }
}

export async function tlsTest(): Promise<{ ok: boolean; [k: string]: unknown }> {
  const res = await fetch("/api/admin/tls/test", {
    method: "POST",
    credentials: "include",
  });
  return res.json();
}

export interface TlsHealthResponse {
  ok: boolean;
  domain: string;
  resolver: "public-alpn" | "dns-01" | "self-ca" | "default-fallback" | "lan" | "unknown";
  issuer: string;
  notBefore: string;
  notAfter: string;
  daysToExpiry: number | null;
  warnings: string[];
}

export interface HealthResponse {
  status: string;
  sha?: string;
  startedAt?: string;
  tls?: TlsHealthResponse;
}

export async function getHealth(): Promise<HealthResponse> {
  const res = await fetch("/api/health", { credentials: "include" });
  return res.json();
}

// ---- generic API helper -------------------------------------------------

/** Fetch wrapper that includes credentials and handles 401 globally. */
export async function api(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  // `cache: "no-store"` is critical for polling endpoints like
  // /api/admin/version. Without it, the browser's HTTP heuristic cache
  // can serve a stale response for minutes even though the server has
  // moved on — the update modal's "Restarting server" detection
  // silently stalls because `info.current.sha` never updates.
  const res = await fetch(path, {
    ...options,
    credentials: "include",
    cache: "no-store",
  });
  if (res.status === 401) {
    // Force reload to show login page
    window.location.reload();
    throw new Error("Unauthorized");
  }
  return res;
}
