import { useEffect, useState, useCallback } from "react";
import { api } from "../lib/api.ts";
import { useAuthStore } from "../stores/auth.ts";

type Provider =
  | "cloudflare"
  | "digitalocean"
  | "digitalocean-apps"
  | "docker"
  | "dokploy"
  | "b2"
  | "github";

const PROVIDER_LABEL: Record<Provider, string> = {
  cloudflare: "Cloudflare DNS",
  digitalocean: "DigitalOcean (Droplets)",
  "digitalocean-apps": "DigitalOcean App Platform",
  docker: "Docker host",
  dokploy: "Dokploy",
  b2: "Backblaze B2",
  github: "GitHub",
};

// Compute providers have a hosting node to provision/destroy. DO Apps +
// GitHub are PaaS/auth — no per-infra provisioning step.
const COMPUTE_PROVIDERS: ReadonlySet<Provider> = new Set(["docker", "digitalocean", "dokploy"]);

interface InfraConfig {
  id: string;
  name: string;
  provider: Provider;
  config: Record<string, string | undefined>;
  hostingNodeIp: string | null;
  hostingNodeId: string | null;
  status: string;
  statusDetail: string | null;
}

interface StatusResponse {
  status: string;
  statusDetail: string | null;
  hostingNodeIp: string | null;
  hostingNodeId: string | null;
}

const STATUS_DOT: Record<string, string> = {
  pending: "bg-zinc-500",
  provisioning: "bg-yellow-400",
  ready: "bg-green-400",
  error: "bg-red-400",
};

const STATUS_COLOR: Record<string, string> = {
  pending: "text-zinc-500",
  provisioning: "text-yellow-400",
  ready: "text-green-400",
  error: "text-red-400",
};

const STATUS_LABEL: Record<string, string> = {
  ready: "Ready",
  provisioning: "Provisioning...",
  error: "Failed",
  pending: "Not provisioned",
};

// --- Config Card ---

function ConfigCard({
  infra,
  onRefresh,
}: {
  infra: InfraConfig;
  onRefresh: () => void;
}) {
  const [current, setCurrent] = useState(infra);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const isCompute = COMPUTE_PROVIDERS.has(current.provider);

  useEffect(() => setCurrent(infra), [infra]);

  // Poll while provisioning
  useEffect(() => {
    if (current.status !== "provisioning") return;
    const interval = setInterval(async () => {
      try {
        const res = await api(`/api/infra/${current.id}/status`);
        if (res.ok) {
          const data = (await res.json()) as StatusResponse;
          setCurrent((prev) => ({
            ...prev,
            status: data.status,
            statusDetail: data.statusDetail,
            hostingNodeIp: data.hostingNodeIp,
            hostingNodeId: data.hostingNodeId,
          }));
          if (data.status !== "provisioning") {
            setProvisioning(false);
            if (data.status === "ready") {
              setMessage({ text: "Hosting node ready", error: false });
              onRefresh();
            } else if (data.status === "error") {
              setMessage({ text: data.statusDetail ?? "Failed", error: true });
            }
          }
        }
      } catch { /* retry */ }
    }, 3_000);
    return () => clearInterval(interval);
  }, [current.id, current.status, onRefresh]);

  const handleVerify = async () => {
    setMessage(null);
    try {
      const res = await api(`/api/infra/${current.id}/verify`, { method: "POST" });
      const body = (await res.json()) as { ok?: boolean; issues?: string[]; error?: string };
      if (res.ok && body.ok) {
        setMessage({ text: "Verified", error: false });
      } else {
        setMessage({
          text: body.error ?? body.issues?.join(", ") ?? "Verify failed",
          error: true,
        });
      }
    } catch {
      setMessage({ text: "Verify failed", error: true });
    }
  };

  const handleProvision = async () => {
    setProvisioning(true);
    setMessage(null);
    try {
      const res = await api(`/api/infra/${current.id}/provision`, { method: "POST" });
      if (res.ok) {
        setCurrent((prev) => ({ ...prev, status: "provisioning", statusDetail: "Starting..." }));
      } else {
        const body = (await res.json()) as { error?: string };
        setMessage({ text: body.error ?? "Failed", error: true });
        setProvisioning(false);
      }
    } catch {
      setMessage({ text: "Failed", error: true });
      setProvisioning(false);
    }
  };

  const handleDestroyNode = async () => {
    if (!confirm(`Destroy hosting node for "${current.name}"? Apps deployed to it will be lost.`)) return;
    try {
      const res = await api(`/api/infra/${current.id}/hosting-node`, { method: "DELETE" });
      if (res.ok) {
        setMessage({ text: "Destroyed", error: false });
        onRefresh();
      } else {
        const body = (await res.json()) as { error?: string };
        setMessage({ text: body.error ?? "Failed", error: true });
      }
    } catch {
      setMessage({ text: "Failed", error: true });
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete "${current.name}" integration?`)) return;
    try {
      const res = await api(`/api/infra/${current.id}`, { method: "DELETE" });
      if (res.ok) onRefresh();
      else {
        const body = (await res.json()) as { error?: string };
        setMessage({ text: body.error ?? "Failed", error: true });
      }
    } catch {
      setMessage({ text: "Failed", error: true });
    }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className={`w-2 h-2 rounded-full ${STATUS_DOT[current.status] ?? "bg-zinc-500"} ${current.status === "provisioning" ? "animate-pulse" : ""}`} />
            <h3 className="font-medium text-zinc-100">{current.name}</h3>
          </div>
          <span className="text-xs text-zinc-500">{PROVIDER_LABEL[current.provider] ?? current.provider}</span>
        </div>
        {isCompute && (
          <span className={`text-xs ${STATUS_COLOR[current.status] ?? "text-zinc-500"}`}>
            {STATUS_LABEL[current.status] ?? current.status}
          </span>
        )}
      </div>

      {current.hostingNodeIp && (
        <p className="text-sm text-zinc-300 mb-1">
          {current.provider === "dokploy" ? "URL" : "IP"}: <code className="text-zinc-100">{current.hostingNodeIp}</code>
          {current.hostingNodeId && <span className="text-xs text-zinc-500 ml-2">ID: {current.hostingNodeId}</span>}
        </p>
      )}

      {current.statusDetail && current.status !== "ready" && (
        <p className={`text-xs mb-2 ${current.status === "error" ? "text-red-400" : "text-zinc-500"}`}>
          {current.statusDetail}
        </p>
      )}

      <div className="flex flex-wrap gap-2 mt-2">
        <button
          onClick={() => void handleVerify()}
          className="px-3 py-1.5 text-xs text-zinc-300 border border-zinc-700 rounded-lg hover:bg-zinc-800 transition-colors"
        >
          Verify
        </button>
        {isCompute && (current.status === "pending" || current.status === "error") && (
          <button
            onClick={() => void handleProvision()}
            disabled={provisioning}
            className="px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-lg hover:bg-green-500 disabled:opacity-50 transition-colors"
          >
            {provisioning ? "Provisioning..." : current.status === "error" ? "Retry" : "Provision"}
          </button>
        )}
        {isCompute && current.status === "ready" && (
          <button
            onClick={() => void handleDestroyNode()}
            className="px-3 py-1.5 text-xs text-red-400 border border-zinc-700 rounded-lg hover:bg-zinc-800 transition-colors"
          >
            Destroy Node
          </button>
        )}
        <button
          onClick={() => void handleDelete()}
          className="px-3 py-1.5 text-xs text-zinc-400 border border-zinc-700 rounded-lg hover:text-zinc-200 transition-colors ml-auto"
        >
          Delete
        </button>
      </div>

      {message && (
        <p className={`mt-2 text-xs ${message.error ? "text-red-400" : "text-green-400"}`}>{message.text}</p>
      )}
    </div>
  );
}

// --- Add Config Form ---

type FieldValues = Record<string, string>;

function renderFields(
  provider: Provider,
  values: FieldValues,
  setValue: (key: string, value: string) => void,
): React.ReactNode {
  const input = (
    key: string,
    label: string,
    placeholder: string,
    type: "text" | "password" = "text",
    span?: 1 | 2,
  ) => (
    <div className={span === 2 ? "col-span-2" : undefined}>
      <label className="block text-xs text-zinc-500 mb-1">{label}</label>
      <input
        type={type}
        value={values[key] ?? ""}
        onChange={(e) => setValue(key, e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none"
      />
    </div>
  );

  const textarea = (key: string, label: string, placeholder: string) => (
    <div className="col-span-2">
      <label className="block text-xs text-zinc-500 mb-1">{label}</label>
      <textarea
        value={values[key] ?? ""}
        onChange={(e) => setValue(key, e.target.value)}
        placeholder={placeholder}
        rows={4}
        className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm font-mono focus:border-purple-500 focus:outline-none"
      />
    </div>
  );

  switch (provider) {
    case "cloudflare":
      return (
        <>
          {input("apiToken", "API Token", "CF API token", "password")}
          {input("zoneId", "Zone ID", "Zone ID from CF dashboard")}
        </>
      );
    case "digitalocean":
      return (
        <>
          {input("apiToken", "API Token", "dop_v1_...", "password", 2)}
          {input("region", "Region", "sfo3, nyc3, lon1…")}
          {input("size", "Size (optional)", "s-2vcpu-4gb")}
          {input("image", "Image (optional)", "docker-20-04")}
          {input("sshKeyId", "SSH Key ID", "numeric ID or fingerprint")}
        </>
      );
    case "docker":
      return (
        <>
          {input("hostIp", "Host IP or hostname", "1.2.3.4", "text", 2)}
          {input("sshUser", "SSH user (optional)", "root")}
          {input("", "", "", "text")}
          {textarea("sshPrivateKey", "SSH Private Key", "-----BEGIN OPENSSH PRIVATE KEY-----")}
        </>
      );
    case "dokploy":
      return (
        <>
          {input("baseUrl", "Base URL", "https://dokploy.example.com", "text", 2)}
          {input("apiToken", "API Token", "Dokploy API token", "password", 2)}
          {input("projectId", "Project ID", "proj_...")}
          {input("environmentId", "Environment ID", "env_...")}
          {input(
            "publicHost",
            "Public Host (optional)",
            "IP or hostname agents should point DNS at — leaves the baseUrl host as default",
            "text",
            2,
          )}
        </>
      );
    case "b2":
      return (
        <>
          {input("b2KeyId", "Application Key ID", "00abc1234def")}
          {input("b2Bucket", "Bucket Name", "my-backup-bucket")}
          {input("b2AppKey", "Application Key", "K001xxxx...", "password", 2)}
        </>
      );
    case "digitalocean-apps":
      return (
        <>
          {input("apiToken", "API Token", "dop_v1_... with app:* scopes", "password", 2)}
          {input("region", "Region (optional)", "nyc, sfo3, lon1 — defaults to nyc")}
        </>
      );
    case "github":
      return (
        <>
          <div className="col-span-2 text-xs text-yellow-400/90 bg-yellow-500/5 border border-yellow-500/20 rounded px-3 py-2">
            <strong>Deprecated — scheduled for removal on 2026-09-01.</strong>{" "}
            Use the <strong>GitHub App</strong> card at the top of this page instead:
            per-repo scoped, auto-rotating 1-hour tokens, revokes instantly on uninstall,
            no password management. The one remaining use case for this PAT form is
            creating brand-new repos (the App deliberately doesn't request{" "}
            <code>administration:write</code>). If you need that, open an issue so we
            can track it before removal.
          </div>
          {input(
            "pat",
            "Personal Access Token",
            "ghp_... or github_pat_... with contents:write + administration:write + pages:write",
            "password",
            2,
          )}
          {input("owner", "Owner (user or org)", "your-github-login", "text", 2)}
        </>
      );
  }
}

function AddConfigForm({ onCreated }: { onCreated: () => void }) {
  const [provider, setProvider] = useState<Provider>("cloudflare");
  const [name, setName] = useState("");
  const [values, setValues] = useState<FieldValues>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const setValue = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setMessage({ text: "Name required", error: true }); return; }

    // Strip empty values so backend's validation sees only provided fields.
    const config: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if (k && v.trim()) config[k] = v.trim();
    }

    setSaving(true);
    setMessage(null);
    try {
      const res = await api("/api/infra", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), provider, config }),
      });
      if (res.ok) {
        setMessage({ text: "Created", error: false });
        setName("");
        setValues({});
        onCreated();
      } else {
        const body = (await res.json()) as { error?: string };
        setMessage({ text: body.error ?? "Failed", error: true });
      }
    } catch {
      setMessage({ text: "Failed", error: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. cf-prod, do-staging, home-docker"
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Provider</label>
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as Provider);
              setValues({});
              setMessage(null);
            }}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none"
          >
            <option value="cloudflare">Cloudflare DNS</option>
            <option value="digitalocean">DigitalOcean (Droplets)</option>
            <option value="digitalocean-apps">DigitalOcean App Platform</option>
            <option value="docker">Docker host</option>
            <option value="dokploy">Dokploy</option>
            <option value="github">GitHub</option>
            <option value="b2">Backblaze B2 (backups)</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {renderFields(provider, values, setValue)}
      </div>

      {message && (
        <p className={`text-sm ${message.error ? "text-red-400" : "text-green-400"}`}>{message.text}</p>
      )}

      <button
        type="submit"
        disabled={saving || !name.trim()}
        className="w-full py-2 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {saving ? "Creating..." : "Add integration"}
      </button>
    </form>
  );
}

// --- Main Page ---

interface GithubInstallation {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  suspendedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

interface GithubIntegrationStatus {
  registered: boolean;
  installations: GithubInstallation[];
}

// Admin-only — populated from /api/admin/github-app/status so the
// registration panel can link out to the App's page on GitHub and offer
// re-register / unregister controls. Non-admins can't hit that endpoint
// (it's behind the admin middleware) and get `null` here.
interface GithubAppAdminStatus {
  registered: boolean;
  appId?: number;
  slug?: string;
  name?: string;
  htmlUrl?: string;
}

function GithubAppCard({
  status,
  adminStatus,
  isAdmin,
  onRefresh,
  onAdminRefresh,
  banner,
  onDismissBanner,
}: {
  status: GithubIntegrationStatus;
  adminStatus: GithubAppAdminStatus | null;
  isAdmin: boolean;
  onRefresh: () => void;
  onAdminRefresh: () => void;
  banner: { kind: "success" | "error"; text: string } | null;
  onDismissBanner: () => void;
}) {
  const handleInstall = () => {
    // Full-page navigation — the server issues a 302 to github.com. Using
    // window.location keeps the session cookie in the request so the
    // callback authenticates back to this user.
    window.location.href = "/api/integrations/github/install";
  };

  const handleRegister = () => {
    // Pass the browser's current origin to the server so the manifest's
    // webhook + callback URLs match what the user is actually accessing
    // AgentHub through. Matters for installs where compose has
    // DOMAIN=localhost but the admin is proxying via a tunnel —
    // window.location.origin is the tunnel URL, so the manifest uses
    // the tunnel URL, so GitHub can reach it. Inspired by Dokploy's
    // add-github-provider.tsx which builds its manifest client-side
    // the same way.
    //
    // Same reason as handleInstall for using window.location — cookie
    // has to ride along for the manifest-callback to authenticate the
    // admin back on return.
    const url = `/api/admin/github-app/register?origin=${encodeURIComponent(window.location.origin)}`;
    window.location.href = url;
  };

  const handleUnregister = async () => {
    if (
      !confirm(
        "Unregister the GitHub App from AgentHub? The App stays on GitHub's side — you must delete it at github.com/settings/apps/<slug> to fully tear down.",
      )
    )
      return;
    try {
      const res = await api("/api/admin/github-app", { method: "DELETE" });
      if (res.ok) onAdminRefresh();
    } catch {
      // ignore — surfaces as no state change
    }
  };

  const handleRemove = async (install: GithubInstallation) => {
    if (
      !confirm(
        `Remove local record of "${install.accountLogin}"? The App stays installed on GitHub — uninstall it there (GitHub Settings → Applications → Installed GitHub Apps) to fully revoke.`,
      )
    )
      return;
    try {
      const res = await api(`/api/integrations/github/${install.id}`, {
        method: "DELETE",
      });
      if (res.ok) onRefresh();
    } catch {
      // ignore — surfaces as no-op
    }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium text-zinc-100">GitHub App</h3>
          <p className="text-xs text-zinc-500">
            Per-repo access, 1-hour auto-rotating tokens. Preferred over the
            legacy Personal Access Token integration.
          </p>
        </div>
      </div>

      {banner && (
        <div
          className={`px-3 py-2 rounded text-sm flex items-start justify-between gap-2 ${
            banner.kind === "success"
              ? "bg-green-500/10 text-green-400 border border-green-500/30"
              : "bg-red-500/10 text-red-400 border border-red-500/30"
          }`}
        >
          <span>{banner.text}</span>
          <button
            onClick={onDismissBanner}
            className="text-xs opacity-70 hover:opacity-100"
          >
            dismiss
          </button>
        </div>
      )}

      {!status.registered ? (
        isAdmin ? (
          <div className="space-y-3">
            <p className="text-sm text-zinc-300">
              Register this AgentHub install as a GitHub App so users can
              authorize repos without per-user Personal Access Tokens.
            </p>
            <p className="text-xs text-zinc-500">
              You'll be redirected to GitHub to approve the App manifest.
              The manifest uses <b>the URL in your browser's address bar</b>
              for its webhook + callback URLs, so access AgentHub via a
              publicly-reachable address (real domain, Cloudflare Tunnel,
              ngrok) before clicking. GitHub will reject the registration
              if it can't reach that URL.
            </p>
            <button
              onClick={handleRegister}
              className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-500 transition-colors"
            >
              Register GitHub App
            </button>
          </div>
        ) : (
          <p className="text-sm text-zinc-400">
            An admin needs to register the GitHub App here before you can
            install it on your account.
          </p>
        )
      ) : status.installations.length === 0 ? (
        <>
          <p className="text-sm text-zinc-400">
            Install the App on your GitHub account or organization. You'll be
            asked to pick exactly which repos AgentHub can see.
          </p>
          <button
            onClick={handleInstall}
            className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-500 transition-colors"
          >
            Install on GitHub
          </button>
        </>
      ) : (
        <>
          <div className="space-y-2">
            {status.installations.map((install) => (
              <div
                key={install.id}
                className="flex items-center justify-between px-3 py-2 bg-zinc-800/60 border border-zinc-700/50 rounded-lg"
              >
                <div>
                  <p className="text-sm text-zinc-100">
                    <span className="font-mono">{install.accountLogin}</span>
                    <span className="text-xs text-zinc-500 ml-2">
                      {install.accountType === "Organization" ? "org" : "user"}
                    </span>
                    {install.suspendedAt && (
                      <span className="text-xs text-yellow-400 ml-2">
                        (suspended)
                      </span>
                    )}
                    {install.deletedAt && (
                      <span className="text-xs text-red-400 ml-2">
                        (deleted on GitHub)
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {install.repositorySelection === "all"
                      ? "All repos"
                      : "Selected repos"}
                    {" · Installation "}
                    {install.installationId}
                  </p>
                </div>
                <button
                  onClick={() => void handleRemove(install)}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button
            onClick={handleInstall}
            className="px-3 py-1.5 text-xs text-zinc-300 border border-zinc-700 rounded-lg hover:bg-zinc-800 transition-colors"
          >
            Add another account
          </button>
        </>
      )}

      {status.registered && isAdmin && adminStatus?.registered && (
        <div className="pt-3 border-t border-zinc-800 text-xs text-zinc-500 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            Admin:{" "}
            <span className="font-mono text-zinc-300">{adminStatus.name}</span>
            {adminStatus.appId && (
              <span className="text-zinc-600"> (App ID {adminStatus.appId})</span>
            )}
          </span>
          {adminStatus.htmlUrl && (
            <a
              href={adminStatus.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-zinc-300"
            >
              View on GitHub
            </a>
          )}
          <button
            onClick={handleRegister}
            className="text-zinc-400 hover:text-zinc-200 underline"
          >
            Re-register
          </button>
          <button
            onClick={() => void handleUnregister()}
            className="text-red-400 hover:text-red-300 underline"
          >
            Unregister
          </button>
        </div>
      )}
    </div>
  );
}

export function Integrations() {
  const { user } = useAuthStore();
  const isAdmin = user?.role === "admin";
  const [configs, setConfigs] = useState<InfraConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [ghStatus, setGhStatus] = useState<GithubIntegrationStatus | null>(null);
  const [ghAdminStatus, setGhAdminStatus] = useState<GithubAppAdminStatus | null>(null);
  const [ghBanner, setGhBanner] = useState<
    | { kind: "success"; text: string }
    | { kind: "error"; text: string }
    | null
  >(null);

  const fetchConfigs = useCallback(async () => {
    try {
      const res = await api("/api/infra");
      if (res.ok) setConfigs((await res.json()) as InfraConfig[]);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  const fetchGhStatus = useCallback(async () => {
    try {
      const res = await api("/api/integrations/github");
      if (res.ok) setGhStatus((await res.json()) as GithubIntegrationStatus);
    } catch {
      // ignore
    }
  }, []);

  const fetchGhAdminStatus = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await api("/api/admin/github-app/status");
      if (res.ok) setGhAdminStatus((await res.json()) as GithubAppAdminStatus);
    } catch {
      // ignore — admin footer silently hides on failure
    }
  }, [isAdmin]);

  useEffect(() => {
    void fetchConfigs();
    void fetchGhStatus();
    void fetchGhAdminStatus();
  }, [fetchConfigs, fetchGhStatus, fetchGhAdminStatus]);

  useEffect(() => {
    const url = new URL(window.location.href);
    // Table-driven banner reader. The if/else-if chain this replaces
    // silently dropped any param after the first match — which would
    // bite when GitHub redirected with both an install param and a
    // register param (a re-register racing with an install). Now we
    // emit the first matching rule's banner and delete ALL matched
    // params from the URL so they don't stick around on refresh.
    const BANNER_RULES = [
      {
        param: "githubInstallAdded", match: "1",
        banner: { kind: "success" as const, text: "GitHub App installed." },
      },
      {
        param: "githubInstallUpdated", match: "1",
        banner: { kind: "success" as const, text: "GitHub App repos updated." },
      },
      {
        param: "githubAppRegistered", match: "1",
        banner: { kind: "success" as const, text: "GitHub App registered." },
      },
      {
        param: "githubInstallError",
        mkBanner: (v: string) => ({ kind: "error" as const, text: `GitHub App install failed: ${v}` }),
      },
      {
        param: "githubAppError",
        mkBanner: (v: string) => ({ kind: "error" as const, text: `GitHub App registration failed: ${v}` }),
      },
    ];
    let firstBanner: { kind: "success" | "error"; text: string } | null = null;
    for (const rule of BANNER_RULES) {
      const v = url.searchParams.get(rule.param);
      if (!v) continue;
      if ("match" in rule && v !== rule.match) continue;
      const banner = "mkBanner" in rule ? rule.mkBanner(v) : rule.banner;
      firstBanner ??= banner;
      url.searchParams.delete(rule.param);
    }
    if (firstBanner) {
      setGhBanner(firstBanner);
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  if (loading) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <h2 className="text-2xl font-semibold mb-6">Integrations</h2>
        <p className="text-sm text-zinc-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-2xl font-semibold">Integrations</h2>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="px-4 py-2 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-500 transition-colors"
        >
          {showAdd ? "Cancel" : "Add integration"}
        </button>
      </div>
      <p className="text-sm text-zinc-500 mb-6">
        Credentials your agent can use: DNS providers, deploy targets, backup storage.
      </p>

      <div className="max-w-2xl space-y-4">
        {ghStatus?.registered &&
          ghStatus.installations.length === 0 &&
          configs.some((c) => c.provider === "github") && (
            <div className="bg-purple-500/5 border border-purple-500/30 rounded-xl px-4 py-3 text-sm text-purple-200">
              You have a legacy GitHub PAT integration. Install the GitHub
              App below for per-repo scoping + auto-rotating tokens — both
              can coexist while you migrate.
            </div>
          )}

        {ghStatus && (
          <GithubAppCard
            status={ghStatus}
            adminStatus={ghAdminStatus}
            isAdmin={isAdmin}
            onRefresh={() => void fetchGhStatus()}
            onAdminRefresh={() => {
              void fetchGhStatus();
              void fetchGhAdminStatus();
            }}
            banner={ghBanner}
            onDismissBanner={() => setGhBanner(null)}
          />
        )}

        {showAdd && (
          <AddConfigForm onCreated={() => { setShowAdd(false); void fetchConfigs(); }} />
        )}

        {configs.length === 0 && !showAdd ? (
          <div className="text-center py-12">
            <p className="text-zinc-500 text-sm mb-2">No integrations configured</p>
            <p className="text-zinc-600 text-xs">Add Cloudflare DNS, a Docker host, DigitalOcean, Dokploy, or Backblaze B2.</p>
          </div>
        ) : (
          configs.map((c) => (
            <ConfigCard key={c.id} infra={c} onRefresh={() => void fetchConfigs()} />
          ))
        )}
      </div>
    </div>
  );
}
