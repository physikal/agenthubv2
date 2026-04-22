import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { useAuthStore } from "../stores/auth.ts";

interface StoreStatus {
  configured: boolean;
  storeReady?: boolean;
}

interface RevealedCreds {
  email: string;
  password: string;
}

export function Secrets() {
  const { user } = useAuthStore();
  const [status, setStatus] = useState<StoreStatus | null>(null);
  const [revealOpen, setRevealOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [creds, setCreds] = useState<RevealedCreds | null>(null);
  const [revealErr, setRevealErr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

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
  const isAdmin = user?.role === "admin";

  const resetReveal = () => {
    setRevealOpen(false);
    setCurrentPassword("");
    setCreds(null);
    setRevealErr("");
    setShowPassword(false);
  };

  const handleReveal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPassword) return;
    setSubmitting(true);
    setRevealErr("");
    try {
      const res = await api("/api/admin/infisical-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword }),
      });
      const body = (await res.json()) as
        | RevealedCreds
        | { error?: string };
      if (!res.ok) {
        setRevealErr(("error" in body && body.error) || "Reveal failed");
        return;
      }
      setCreds(body as RevealedCreds);
      setCurrentPassword("");
    } catch {
      setRevealErr("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
  };

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

        {isAdmin && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-zinc-200 mb-1">
              Infisical admin login
            </h3>
            <p className="text-xs text-zinc-500 mb-4">
              Infisical has no self-registration — if you don't have the admin
              credentials from install time, reveal them here. Re-enter your
              AgentHub admin password to confirm.
            </p>

            {!revealOpen && !creds && (
              <button
                type="button"
                onClick={() => setRevealOpen(true)}
                className="px-3 py-1.5 text-sm font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 rounded-lg transition-colors"
              >
                Reveal Infisical admin login
              </button>
            )}

            {revealOpen && !creds && (
              <form onSubmit={handleReveal} className="space-y-3">
                <label className="block">
                  <span className="block text-xs text-zinc-400 mb-1">
                    Your AgentHub password
                  </span>
                  <input
                    type="password"
                    autoFocus
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:border-purple-500"
                  />
                </label>
                {revealErr && (
                  <p className="text-xs text-red-400">{revealErr}</p>
                )}
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={submitting || !currentPassword}
                    className="px-3 py-1.5 text-sm font-medium bg-purple-600 hover:bg-purple-500 disabled:bg-zinc-700 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
                  >
                    {submitting ? "Checking…" : "Reveal"}
                  </button>
                  <button
                    type="button"
                    onClick={resetReveal}
                    className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {creds && (
              <div className="space-y-3">
                <div>
                  <div className="text-xs text-zinc-500 mb-1">Email</div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-3 py-2 text-sm bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 font-mono">
                      {creds.email}
                    </code>
                    <button
                      type="button"
                      onClick={() => copy(creds.email)}
                      className="px-2 py-2 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-800 rounded-lg"
                    >
                      Copy
                    </button>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-zinc-500 mb-1">Password</div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-3 py-2 text-sm bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 font-mono break-all">
                      {showPassword ? creds.password : "•".repeat(Math.min(creds.password.length, 24))}
                    </code>
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="px-2 py-2 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-800 rounded-lg"
                    >
                      {showPassword ? "Hide" : "Show"}
                    </button>
                    <button
                      type="button"
                      onClick={() => copy(creds.password)}
                      className="px-2 py-2 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-800 rounded-lg"
                    >
                      Copy
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={resetReveal}
                  className="text-xs text-zinc-500 hover:text-zinc-300"
                >
                  Hide credentials
                </button>
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-zinc-600">
          Self-signed TLS cert on :8443 — your browser will prompt once, accept to continue.
        </p>
      </div>
    </div>
  );
}
