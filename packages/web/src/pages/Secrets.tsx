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

  // For DOMAIN=localhost installs reached from another box, secrets.localhost
  // won't resolve — show the hosts-file hint inline rather than making users
  // hunt through docs.
  const pageHost = typeof window !== "undefined" ? window.location.hostname : "localhost";
  const infisicalUrl = `https://secrets.${pageHost}/`;
  const needsHostsEntry = /^\d+\.\d+\.\d+\.\d+$/.test(pageHost) || pageHost === "localhost";

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

        {needsHostsEntry && (
          <div className="bg-amber-950/40 border border-amber-800/60 rounded-xl p-4">
            <p className="text-sm text-amber-200 font-medium mb-1">
              localhost install: one-time setup
            </p>
            <p className="text-xs text-amber-200/80 mb-2">
              The Infisical console lives at <code className="text-amber-100">secrets.localhost</code>,
              which doesn't resolve from a browser unless you map it. Add this line to your
              machine's <code className="text-amber-100">/etc/hosts</code> (once):
            </p>
            <pre className="text-xs text-amber-100 bg-amber-950/60 rounded px-3 py-2 font-mono">
              {pageHost} secrets.localhost
            </pre>
            <p className="text-xs text-amber-200/70 mt-2">
              Then reload this page and click the button above. On real-domain installs
              (<code>AGENTHUB_DOMAIN=example.com</code>) this isn't needed — DNS handles it.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
