import { useEffect, useState, useCallback } from "react";
import { api } from "../lib/api.ts";

interface InfraConfig {
  id: string;
  name: string;
  provider: string;
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
  healthy?: boolean;
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
  ready: "Active",
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

  const handleDestroy = async () => {
    if (!confirm(`Destroy hosting node for "${current.name}"? All deployed apps on it will be lost.`)) return;
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
    if (!confirm(`Delete "${current.name}" configuration?`)) return;
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
          <span className="text-xs text-zinc-500">{current.provider}</span>
        </div>
        <span className={`text-xs ${STATUS_COLOR[current.status] ?? "text-zinc-500"}`}>
          {STATUS_LABEL[current.status] ?? current.status}
        </span>
      </div>

      {current.hostingNodeIp && (
        <p className="text-sm text-zinc-300 mb-1">
          IP: <code className="text-zinc-100">{current.hostingNodeIp}</code>
          {current.hostingNodeId && <span className="text-xs text-zinc-500 ml-2">ID: {current.hostingNodeId}</span>}
        </p>
      )}

      {current.statusDetail && current.status !== "ready" && (
        <p className={`text-xs mb-2 ${current.status === "error" ? "text-red-400" : "text-zinc-500"}`}>
          {current.statusDetail}
        </p>
      )}

      <div className="flex gap-2 mt-2">
        {(current.status === "pending" || current.status === "error") && (
          <button
            onClick={() => void handleProvision()}
            disabled={provisioning}
            className="px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-lg hover:bg-green-500 disabled:opacity-50 transition-colors"
          >
            {provisioning ? "Provisioning..." : current.status === "error" ? "Retry" : "Provision"}
          </button>
        )}
        {current.status === "ready" && (
          <button
            onClick={() => void handleDestroy()}
            className="px-3 py-1.5 text-xs text-red-400 border border-zinc-700 rounded-lg hover:bg-zinc-800 transition-colors"
          >
            Destroy Node
          </button>
        )}
        <button
          onClick={() => void handleDelete()}
          className="px-3 py-1.5 text-xs text-zinc-400 border border-zinc-700 rounded-lg hover:text-zinc-200 transition-colors"
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

function AddConfigForm({ onCreated }: { onCreated: () => void }) {
  const [provider, setProvider] = useState("proxmox");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  // Proxmox fields
  const [apiUrl, setApiUrl] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [tokenSecret, setTokenSecret] = useState("");
  const [node, setNode] = useState("");
  const [storage, setStorage] = useState("");

  // Cloudflare
  const [cfToken, setCfToken] = useState("");
  const [cfZoneId, setCfZoneId] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setMessage({ text: "Name required", error: true }); return; }

    let config: Record<string, string> = {};
    if (provider === "proxmox") {
      if (!apiUrl || !tokenId || !tokenSecret || !node || !storage) {
        setMessage({ text: "All Proxmox fields required", error: true }); return;
      }
      config = { apiUrl, tokenId, tokenSecret, node, storage };
    } else if (provider === "cloudflare") {
      if (!cfToken || !cfZoneId) { setMessage({ text: "API token and Zone ID required", error: true }); return; }
      config = { apiToken: cfToken, zoneId: cfZoneId };
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
        setName(""); setApiUrl(""); setTokenId(""); setTokenSecret("");
        setNode(""); setStorage(""); setCfToken(""); setCfZoneId("");
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
            placeholder="e.g. proxmox-home, do-staging"
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Provider</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none"
          >
            <option value="proxmox">Proxmox</option>
            <option value="cloudflare">Cloudflare DNS</option>
          </select>
        </div>
      </div>

      {provider === "cloudflare" ? (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">API Token</label>
            <input type="password" value={cfToken} onChange={(e) => setCfToken(e.target.value)} placeholder="CF API token"
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Zone ID</label>
            <input value={cfZoneId} onChange={(e) => setCfZoneId(e.target.value)} placeholder="Zone ID from CF dashboard"
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none" />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="block text-xs text-zinc-500 mb-1">API URL</label>
            <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://192.168.5.100:8006/api2/json"
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Token ID</label>
            <input value={tokenId} onChange={(e) => setTokenId(e.target.value)} placeholder="root@pam!deploy"
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Token Secret</label>
            <input type="password" value={tokenSecret} onChange={(e) => setTokenSecret(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx"
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Node</label>
            <input value={node} onChange={(e) => setNode(e.target.value)} placeholder="pve05"
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Storage</label>
            <input value={storage} onChange={(e) => setStorage(e.target.value)} placeholder="local-lvm"
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none" />
          </div>
        </div>
      )}

      {message && (
        <p className={`text-sm ${message.error ? "text-red-400" : "text-green-400"}`}>{message.text}</p>
      )}

      <button
        type="submit"
        disabled={saving || !name.trim()}
        className="w-full py-2 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {saving ? "Creating..." : "Add Infrastructure"}
      </button>
    </form>
  );
}

// --- Main Page ---

export function Infrastructure() {
  const [configs, setConfigs] = useState<InfraConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  const fetchConfigs = useCallback(async () => {
    try {
      const res = await api("/api/infra");
      if (res.ok) setConfigs((await res.json()) as InfraConfig[]);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void fetchConfigs(); }, [fetchConfigs]);

  if (loading) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <h2 className="text-2xl font-semibold mb-6">Infrastructure</h2>
        <p className="text-sm text-zinc-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-2xl font-semibold">Infrastructure</h2>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="px-4 py-2 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-500 transition-colors"
        >
          {showAdd ? "Cancel" : "Add Config"}
        </button>
      </div>
      <p className="text-sm text-zinc-500 mb-6">
        Add multiple infrastructure configs. Each gets its own hosting node for deployments.
      </p>

      <div className="max-w-lg space-y-4">
        {showAdd && (
          <AddConfigForm onCreated={() => { setShowAdd(false); void fetchConfigs(); }} />
        )}

        {configs.length === 0 && !showAdd ? (
          <div className="text-center py-12">
            <p className="text-zinc-500 text-sm mb-2">No infrastructure configured</p>
            <p className="text-zinc-600 text-xs">Add a Proxmox or DigitalOcean config to get started.</p>
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
