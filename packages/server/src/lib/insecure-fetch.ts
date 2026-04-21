import { Agent, fetch as undiciFetch } from "undici";

/**
 * Proxmox ships with self-signed certificates by default. We need to let the
 * server talk to the PVE API without spoiling TLS verification for the rest
 * of the process (Cloudflare API, DigitalOcean API, future outbound calls).
 *
 * If `NODE_EXTRA_CA_CERTS` is set — the correct production path — we trust
 * the PVE CA globally and return a regular fetch. Otherwise we fall back to
 * a SINGLE dispatcher that skips verification, used only by the callers in
 * this module. That dispatcher is scoped: it never leaks to `globalThis.fetch`
 * or any other consumer of `fetch` in the codebase.
 *
 * An on-path attacker against a foreign HTTPS host cannot use this to MITM
 * us — only Proxmox calls route through the lax dispatcher.
 */

const insecureDispatcher = process.env["NODE_EXTRA_CA_CERTS"]
  ? null
  : new Agent({
      connect: { rejectUnauthorized: false },
    });

if (insecureDispatcher) {
  console.warn(
    "[tls] NODE_EXTRA_CA_CERTS not set — Proxmox API calls will skip TLS verification. " +
      "Set NODE_EXTRA_CA_CERTS=/path/to/pve-ca.pem for proper certificate validation.",
  );
}

/**
 * Fetch a Proxmox URL, bypassing TLS verification for its self-signed cert.
 * Returns the global `Response` type for caller ergonomics — undici's
 * Response is structurally compatible with what every consumer needs
 * (`ok`, `status`, `text()`, `json()`).
 */
export async function proxmoxFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!insecureDispatcher) {
    return fetch(url, init);
  }

  // Forward only the fields undici's fetch accepts. Build the object
  // conditionally — exactOptionalPropertyTypes rejects explicit `undefined`.
  const undiciInit: Parameters<typeof undiciFetch>[1] = { dispatcher: insecureDispatcher };
  if (init.method !== undefined) undiciInit.method = init.method;
  if (init.headers !== undefined) undiciInit.headers = init.headers as Record<string, string>;
  if (init.body !== undefined && init.body !== null) {
    undiciInit.body = init.body as string | Uint8Array;
  }

  const resp = await undiciFetch(url, undiciInit);
  return resp as unknown as Response;
}
