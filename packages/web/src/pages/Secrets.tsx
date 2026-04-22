import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";

interface StoreStatus {
  configured: boolean;
  storeReady?: boolean;
}

export function Secrets() {
  const [status, setStatus] = useState<StoreStatus | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        // /api/user/backup happens to return { storeReady } derived from the
        // Infisical SDK state — cheapest way to answer "is the secret store
        // up?" without adding a new endpoint.
        const res = await api("/api/user/backup");
        if (res.ok) {
          setStatus((await res.json()) as StoreStatus);
        } else {
          setStatus({ configured: false, storeReady: false });
        }
      } catch {
        setStatus({ configured: false, storeReady: false });
      }
    })();
  }, []);

  // Infisical runs behind its own Traefik entrypoint on port 8443 — no
  // subdomain, no /etc/hosts, works from any browser that can reach the
  // host. Same origin host the user is already on + port 8443.
  const pageHost = typeof window !== "undefined" ? window.location.hostname : "localhost";
  const infisicalUrl = `https://${pageHost}:8443/`;

  const storeReady = status?.storeReady !== false;

  return (
    <div className="flex-1 overflow-auto p-6">
      <h2 className="text-2xl font-semibold mb-2">Secrets</h2>
      <p className="text-sm text-zinc-500 mb-6">
        Credentials and configuration stored in the bundled Infisical secret store.
      </p>

      <div className="max-w-2xl space-y-6">
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <span
              className={`w-2 h-2 rounded-full ${
                storeReady ? "bg-green-400" : "bg-red-400"
              }`}
            />
            <span className="text-sm text-zinc-300">
              {storeReady ? "Secret store online" : "Secret store not reachable"}
            </span>
          </div>
          <p className="text-sm text-zinc-400 mb-4">
            Common credentials (Cloudflare DNS, Backblaze B2, deploy targets) have typed
            forms on the <a href="/integrations" className="text-purple-400 hover:text-purple-300">Integrations</a> page.
            For anything else — folders, environments, secret versions, audit log, bulk
            import — use the Infisical console directly.
          </p>
          <a
            href={infisicalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-4 py-2 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-500 transition-colors"
          >
            Open Infisical console →
          </a>
        </div>

        <p className="text-xs text-zinc-600">
          Self-signed TLS cert on :8443 — your browser will prompt once, accept to continue.
        </p>
      </div>
    </div>
  );
}
