import { useEffect, useState, useCallback } from "react";
import { api } from "../lib/api.ts";

interface Deployment {
  id: string;
  name: string;
  domain: string | null;
  url: string | null;
  internalOnly: boolean;
  status: string;
  statusDetail: string | null;
  sourcePath: string | null;
  infraName: string;
  username?: string;
  createdAt: string;
  updatedAt: string;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${String(mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${String(hours)}h ${String(mins % 60)}m ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

function statusDot(status: string): string {
  switch (status) {
    case "running": return "bg-green-400";
    case "deploying": return "bg-yellow-400 animate-pulse";
    case "stopped": return "bg-zinc-500";
    case "failed": return "bg-red-400";
    default: return "bg-zinc-600";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "running": return "Running";
    case "deploying": return "Deploying...";
    case "stopped": return "Stopped";
    case "failed": return "Failed";
    case "destroyed": return "Destroyed";
    default: return status;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "running": return "text-green-400";
    case "deploying": return "text-yellow-400";
    case "failed": return "text-red-400";
    default: return "text-zinc-500";
  }
}

export function Deployments() {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ text: string; error: boolean } | null>(null);

  const fetchDeployments = useCallback(async () => {
    try {
      const res = await api("/api/deployments");
      if (res.ok) {
        setDeployments((await res.json()) as Deployment[]);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchDeployments();
  }, [fetchDeployments]);

  // Auto-refresh while any deployment is in "deploying" state
  useEffect(() => {
    const hasDeploying = deployments.some((d) => d.status === "deploying");
    if (!hasDeploying) return;

    const interval = setInterval(() => void fetchDeployments(), 5_000);
    return () => clearInterval(interval);
  }, [deployments, fetchDeployments]);

  const handleViewLogs = async (id: string) => {
    if (selectedId === id && logs !== null) {
      setSelectedId(null);
      setLogs(null);
      return;
    }
    setSelectedId(id);
    setLogs(null);
    setLogsLoading(true);
    try {
      const res = await api(`/api/deployments/${id}/logs?lines=80`);
      if (res.ok) {
        const data = (await res.json()) as { logs: string };
        setLogs(data.logs);
      } else {
        setLogs("Failed to fetch logs");
      }
    } catch {
      setLogs("Failed to fetch logs");
    } finally {
      setLogsLoading(false);
    }
  };

  const handleRestart = async (id: string) => {
    setActionMsg(null);
    try {
      const res = await api(`/api/deployments/${id}/restart`, { method: "POST" });
      if (res.ok) {
        setActionMsg({ text: "Restarted", error: false });
        void fetchDeployments();
      } else {
        const body = (await res.json()) as { error?: string };
        setActionMsg({ text: body.error ?? "Restart failed", error: true });
      }
    } catch {
      setActionMsg({ text: "Restart failed", error: true });
    }
  };

  const handleDestroy = async (id: string, name: string) => {
    if (!confirm(`Destroy "${name}"? This removes containers, volumes, and DNS records.`)) return;

    setActionMsg(null);
    try {
      const res = await api(`/api/deployments/${id}`, { method: "DELETE" });
      if (res.ok) {
        setActionMsg({ text: `"${name}" destroyed`, error: false });
        if (selectedId === id) {
          setSelectedId(null);
          setLogs(null);
        }
        void fetchDeployments();
      } else {
        const body = (await res.json()) as { error?: string };
        setActionMsg({ text: body.error ?? "Destroy failed", error: true });
      }
    } catch {
      setActionMsg({ text: "Destroy failed", error: true });
    }
  };

  if (loading) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <h2 className="text-2xl font-semibold mb-6">Deployments</h2>
        <p className="text-sm text-zinc-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-semibold">Deployments</h2>
        <span className="text-xs text-zinc-500">
          {deployments.length} app{deployments.length !== 1 ? "s" : ""}
        </span>
      </div>

      {actionMsg && (
        <div className={`mb-4 px-4 py-2 rounded-lg text-sm ${actionMsg.error ? "bg-red-500/10 text-red-400" : "bg-green-500/10 text-green-400"}`}>
          {actionMsg.text}
        </div>
      )}

      {deployments.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-zinc-500 text-sm mb-2">No deployments yet</p>
          <p className="text-zinc-600 text-xs">
            Use the <code className="text-zinc-400">deploy</code> tool in a Claude Code session to deploy an app.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {deployments.map((d) => (
            <div key={d.id}>
              {/* Card */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2.5">
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${statusDot(d.status)}`} />
                    <h3 className="font-medium text-zinc-100">{d.name}</h3>
                  </div>
                  <span className={`text-xs ${statusColor(d.status)}`}>
                    {statusLabel(d.status)}
                  </span>
                </div>

                {/* URL */}
                {(d.url ?? (d.domain ? `https://${d.domain}` : null)) && (
                  <a
                    href={d.url ?? `https://${d.domain}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block text-sm text-purple-400 hover:text-purple-300 mb-2 transition-colors"
                  >
                    {d.url ?? `https://${d.domain}`} ↗
                  </a>
                )}

                {/* Details row */}
                <div className="flex items-center gap-3 text-xs text-zinc-500 mb-3">
                  <span>Deployed {timeAgo(d.createdAt)}</span>
                  {d.username && (
                    <>
                      <span>·</span>
                      <span className="text-zinc-400">{d.username}</span>
                    </>
                  )}
                  <span>·</span>
                  <span className="text-zinc-400">{d.infraName}</span>
                  {d.sourcePath && (
                    <>
                      <span>·</span>
                      <span className="font-mono truncate max-w-[200px]">{d.sourcePath}</span>
                    </>
                  )}
                </div>

                {/* Status detail (for deploying/failed) */}
                {d.statusDetail && d.status !== "running" && (
                  <p className={`text-xs mb-3 ${d.status === "failed" ? "text-red-400" : "text-zinc-500"}`}>
                    {d.statusDetail}
                  </p>
                )}

                {/* Actions */}
                <div className="flex gap-2">
                  <button
                    onClick={() => void handleViewLogs(d.id)}
                    className="px-3 py-1.5 text-xs text-zinc-300 bg-zinc-800 border border-zinc-700 rounded-lg hover:bg-zinc-700 transition-colors"
                  >
                    {selectedId === d.id && logs !== null ? "Hide Logs" : "Logs"}
                  </button>
                  {d.status === "running" && (
                    <button
                      onClick={() => void handleRestart(d.id)}
                      className="px-3 py-1.5 text-xs text-zinc-300 bg-zinc-800 border border-zinc-700 rounded-lg hover:bg-zinc-700 transition-colors"
                    >
                      Restart
                    </button>
                  )}
                  {d.status !== "destroyed" && (
                    <button
                      onClick={() => void handleDestroy(d.id, d.name)}
                      className="px-3 py-1.5 text-xs text-red-400 border border-zinc-700 rounded-lg hover:bg-zinc-800 transition-colors"
                    >
                      Destroy
                    </button>
                  )}
                </div>
              </div>

              {/* Logs panel */}
              {selectedId === d.id && (
                <div className="mt-1 bg-zinc-950 border border-zinc-800 rounded-xl p-4 overflow-hidden">
                  {logsLoading ? (
                    <p className="text-xs text-zinc-500">Loading logs...</p>
                  ) : (
                    <pre className="text-xs text-zinc-400 font-mono whitespace-pre-wrap overflow-x-auto max-h-80">
                      {logs || "(no logs)"}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
