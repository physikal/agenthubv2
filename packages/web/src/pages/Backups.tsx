import { Fragment, useEffect, useState, useCallback } from "react";
import { api } from "../lib/api.ts";

interface BackupConfig {
  configured: boolean;
  b2KeyId?: string;
  b2AppKey?: string;
  b2Bucket?: string;
}

interface BackupSize {
  count: number;
  bytes: number;
}

interface BackupRun {
  id: string;
  kind: "save" | "restore";
  status: "running" | "success" | "failed";
  startedAt: number;
  endedAt: number | null;
  bytes: number | null;
  fileCount: number | null;
  snapshotAt: number | null;
  error: string | null;
}

interface VersioningStatus {
  status: "enabled" | "limited" | "disabled" | "unknown";
  retentionDays: number | null;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  return `${String(m)}m ${String(s % 60)}s`;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${String(days)}d ago`;
  return formatTimestamp(ts);
}

export function Backups() {
  // Config state
  const [config, setConfig] = useState<BackupConfig | null>(null);
  const [b2KeyId, setB2KeyId] = useState("");
  const [b2AppKey, setB2AppKey] = useState("");
  const [b2Bucket, setB2Bucket] = useState("");
  const [configSaving, setConfigSaving] = useState(false);
  const [configMessage, setConfigMessage] = useState<{ text: string; error: boolean } | null>(null);

  // Status state
  const [size, setSize] = useState<BackupSize | null>(null);
  const [loadingSize, setLoadingSize] = useState(false);

  // Runs state
  const [runs, setRuns] = useState<BackupRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);

  // Versioning probe
  const [versioning, setVersioning] = useState<VersioningStatus | null>(null);

  // Operation state
  const [operating, setOperating] = useState<"save" | "restore" | null>(null);
  const [opMessage, setOpMessage] = useState<{ text: string; error: boolean } | null>(null);

  // Details panel: id of the run whose error is being inspected
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await api("/api/user/backup");
      if (res.ok) {
        const data = (await res.json()) as BackupConfig;
        setConfig(data);
        if (data.configured) {
          setB2KeyId(data.b2KeyId ?? "");
          setB2Bucket(data.b2Bucket ?? "");
          setB2AppKey("");
        }
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchSize = useCallback(async () => {
    setLoadingSize(true);
    try {
      const res = await api("/api/user/backup/status");
      if (res.ok) {
        setSize((await res.json()) as BackupSize);
      }
    } catch {
      // ignore
    } finally {
      setLoadingSize(false);
    }
  }, []);

  const fetchRuns = useCallback(async () => {
    setLoadingRuns(true);
    try {
      const res = await api("/api/user/backup/runs");
      if (res.ok) {
        setRuns((await res.json()) as BackupRun[]);
      }
    } catch {
      // ignore
    } finally {
      setLoadingRuns(false);
    }
  }, []);

  const fetchVersioning = useCallback(async () => {
    try {
      const res = await api("/api/user/backup/versioning");
      if (res.ok) {
        setVersioning((await res.json()) as VersioningStatus);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  useEffect(() => {
    if (config?.configured) {
      void fetchSize();
      void fetchRuns();
      void fetchVersioning();
    }
  }, [config?.configured, fetchSize, fetchRuns, fetchVersioning]);

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!b2KeyId.trim() || !b2AppKey.trim() || !b2Bucket.trim()) {
      setConfigMessage({ text: "All fields required", error: true });
      return;
    }

    setConfigSaving(true);
    setConfigMessage(null);

    try {
      const res = await api("/api/user/backup", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ b2KeyId: b2KeyId.trim(), b2AppKey: b2AppKey.trim(), b2Bucket: b2Bucket.trim() }),
      });

      if (res.ok) {
        setConfigMessage({ text: "Saved", error: false });
        void fetchConfig();
        void fetchSize();
        void fetchRuns();
      } else {
        const body = (await res.json()) as { error?: string };
        setConfigMessage({ text: body.error ?? "Failed", error: true });
      }
    } catch {
      setConfigMessage({ text: "Failed to save", error: true });
    } finally {
      setConfigSaving(false);
    }
  };

  const handleClearConfig = async () => {
    try {
      await api("/api/user/backup", { method: "DELETE" });
      setConfig({ configured: false });
      setB2KeyId("");
      setB2AppKey("");
      setB2Bucket("");
      setSize(null);
      setRuns([]);
      setConfigMessage({ text: "Cleared", error: false });
    } catch {
      setConfigMessage({ text: "Failed to clear", error: true });
    }
  };

  const handleBackup = async () => {
    setOperating("save");
    setOpMessage(null);
    try {
      const res = await api("/api/user/backup/save", { method: "POST" });
      if (res.ok) {
        setOpMessage({ text: "Backup complete", error: false });
        void fetchSize();
      } else {
        const body = (await res.json()) as { error?: string };
        setOpMessage({ text: body.error ?? "Backup failed", error: true });
      }
    } catch {
      setOpMessage({ text: "Backup failed", error: true });
    } finally {
      setOperating(null);
      void fetchRuns();
    }
  };

  const handleRestore = async (snapshotAt?: { iso: string; label: string }) => {
    const label = snapshotAt
      ? `Restore files as they were on ${snapshotAt.label}? This will overwrite current local files.\n\nNote: requires B2 version history to be preserved — if it isn't, the restore will fetch only files still present at that timestamp.`
      : "Restore will overwrite local files with the latest backup contents. Continue?";
    if (!confirm(label)) return;

    setOperating("restore");
    setOpMessage(null);
    try {
      const res = await api("/api/user/backup/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshotAt ? { snapshotAt: snapshotAt.iso } : {}),
      });
      if (res.ok) {
        setOpMessage({
          text: snapshotAt ? `Restored from ${snapshotAt.label}` : "Restore complete",
          error: false,
        });
      } else {
        const body = (await res.json()) as { error?: string };
        setOpMessage({ text: body.error ?? "Restore failed", error: true });
      }
    } catch {
      setOpMessage({ text: "Restore failed", error: true });
    } finally {
      setOperating(null);
      void fetchRuns();
    }
  };

  const successfulSaves = runs.filter((r) => r.kind === "save" && r.status === "success");

  return (
    <div className="flex-1 overflow-auto p-6">
      <h2 className="text-2xl font-semibold mb-6">Backups</h2>

      <div className="max-w-3xl space-y-6">

        {/* Versioning Banner */}
        {config?.configured && versioning && (
          <VersioningBanner status={versioning} onRecheck={() => void fetchVersioning()} />
        )}

        {/* Status Card */}
        {config?.configured && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 bg-green-400 rounded-full" />
                <span className="text-sm text-zinc-300">Connected to B2</span>
              </div>
              <span className="text-xs text-zinc-500">{config.b2Bucket}</span>
            </div>

            <div className="flex items-baseline gap-2 mb-4">
              {loadingSize ? (
                <span className="text-sm text-zinc-500">Checking...</span>
              ) : size ? (
                <>
                  <span className="text-2xl font-semibold text-zinc-100">
                    {formatBytes(size.bytes)}
                  </span>
                  <span className="text-sm text-zinc-500">
                    {String(size.count)} files
                  </span>
                </>
              ) : (
                <span className="text-sm text-zinc-500">No backups yet</span>
              )}
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => void handleBackup()}
                disabled={operating !== null}
                className="flex-1 py-2.5 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {operating === "save" ? "Backing up..." : "Backup now"}
              </button>
              <button
                onClick={() => void handleRestore()}
                disabled={operating !== null}
                className="flex-1 py-2.5 text-sm font-medium bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-lg hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {operating === "restore" ? "Restoring..." : "Restore latest"}
              </button>
              <button
                onClick={() => {
                  void fetchSize();
                  void fetchRuns();
                }}
                disabled={loadingSize || loadingRuns}
                className="px-3 py-2.5 text-sm text-zinc-400 border border-zinc-700 rounded-lg hover:text-zinc-200 transition-colors"
                title="Refresh"
              >
                {loadingSize || loadingRuns ? "..." : "↻"}
              </button>
            </div>

            {opMessage && (
              <p className={`mt-3 text-sm ${opMessage.error ? "text-red-400" : "text-green-400"}`}>
                {opMessage.text}
              </p>
            )}
          </div>
        )}

        {/* Runs / History */}
        {config?.configured && (
          <div>
            <div className="flex items-baseline justify-between mb-3">
              <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">
                Previous runs
              </h3>
              <span className="text-xs text-zinc-600">
                {runs.length > 0 ? `${String(runs.length)} runs` : ""}
              </span>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
              {loadingRuns && runs.length === 0 ? (
                <div className="p-6 text-center text-sm text-zinc-500">Loading...</div>
              ) : runs.length === 0 ? (
                <div className="p-6 text-center text-sm text-zinc-500">
                  No runs yet. Click "Backup now" to create the first one.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-zinc-500 border-b border-zinc-800">
                      <th className="text-left font-medium px-4 py-2">When</th>
                      <th className="text-left font-medium px-4 py-2">Kind</th>
                      <th className="text-left font-medium px-4 py-2">Status</th>
                      <th className="text-right font-medium px-4 py-2">Duration</th>
                      <th className="text-right font-medium px-4 py-2">Size</th>
                      <th className="text-right font-medium px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => {
                      const duration = run.endedAt ? run.endedAt - run.startedAt : null;
                      const isRestoreFromSnapshot = run.kind === "restore" && run.snapshotAt;
                      const canRestoreFromHere =
                        run.kind === "save" && run.status === "success";
                      const expanded = expandedRunId === run.id;

                      return (
                        <Fragment key={run.id}>
                          <tr className="border-t border-zinc-800/60 hover:bg-zinc-800/30 transition-colors">
                            <td className="px-4 py-2.5">
                              <div className="text-zinc-200">{formatRelative(run.startedAt)}</div>
                              <div className="text-xs text-zinc-500">{formatTimestamp(run.startedAt)}</div>
                            </td>
                            <td className="px-4 py-2.5">
                              <span className={`text-xs font-medium ${run.kind === "save" ? "text-purple-300" : "text-blue-300"}`}>
                                {run.kind}
                              </span>
                              {isRestoreFromSnapshot && run.snapshotAt && (
                                <div className="text-[10px] text-zinc-500 mt-0.5">
                                  from {formatTimestamp(run.snapshotAt)}
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-2.5">
                              <StatusBadge status={run.status} />
                            </td>
                            <td className="px-4 py-2.5 text-right text-zinc-400 tabular-nums">
                              {duration !== null ? formatDuration(duration) : "—"}
                            </td>
                            <td className="px-4 py-2.5 text-right text-zinc-400 tabular-nums">
                              {run.bytes !== null ? formatBytes(run.bytes) : "—"}
                            </td>
                            <td className="px-4 py-2.5 text-right">
                              <div className="flex gap-1.5 justify-end">
                                {run.status === "failed" && (
                                  <button
                                    onClick={() =>
                                      setExpandedRunId(expanded ? null : run.id)
                                    }
                                    className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                                  >
                                    {expanded ? "Hide" : "Details"}
                                  </button>
                                )}
                                {canRestoreFromHere && run.endedAt && (
                                  <button
                                    onClick={() =>
                                      void handleRestore({
                                        iso: new Date(run.endedAt as number).toISOString(),
                                        label: formatTimestamp(run.endedAt as number),
                                      })
                                    }
                                    disabled={operating !== null}
                                    className="px-2.5 py-1 text-xs font-medium text-zinc-300 border border-zinc-700 rounded hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                    title="Restore files as they were at this point in time (requires B2 version history)"
                                  >
                                    Restore from here
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                          {expanded && run.error && (
                            <tr className="border-t border-zinc-800/60 bg-zinc-950/60">
                              <td colSpan={6} className="px-4 py-3">
                                <pre className="text-xs text-red-300 whitespace-pre-wrap break-all font-mono">
                                  {run.error}
                                </pre>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {successfulSaves.length > 0 && versioning?.status === "enabled" && (
              <p className="text-xs text-zinc-600 mt-3">
                Point-in-time restore uses B2 file versioning.
              </p>
            )}
          </div>
        )}

        {/* Config Form */}
        <div>
          <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">
            {config?.configured ? "Configuration" : "Setup Backblaze B2"}
          </h3>
          <form
            onSubmit={(e) => void handleSaveConfig(e)}
            className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3"
          >
            <div>
              <label className="block text-xs text-zinc-500 mb-1">B2 Application Key ID</label>
              <input
                value={b2KeyId}
                onChange={(e) => setB2KeyId(e.target.value)}
                placeholder="00abc1234def"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">B2 Application Key</label>
              <input
                type="password"
                value={b2AppKey}
                onChange={(e) => setB2AppKey(e.target.value)}
                placeholder={config?.configured ? "Enter new key to update" : "K001xxxx..."}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Bucket Name</label>
              <input
                value={b2Bucket}
                onChange={(e) => setB2Bucket(e.target.value)}
                placeholder="my-backup-bucket"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none"
              />
            </div>

            {configMessage && (
              <p className={`text-sm ${configMessage.error ? "text-red-400" : "text-green-400"}`}>
                {configMessage.text}
              </p>
            )}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={configSaving || !b2KeyId || !b2AppKey || !b2Bucket}
                className="flex-1 py-2 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {configSaving ? "Saving..." : "Save"}
              </button>
              {config?.configured && (
                <button
                  type="button"
                  onClick={() => void handleClearConfig()}
                  className="px-4 py-2 text-sm text-zinc-400 border border-zinc-700 rounded-lg hover:text-zinc-200 transition-colors"
                >
                  Clear
                </button>
              )}
            </div>

            <p className="text-xs text-zinc-600">
              You can also run <code className="text-zinc-400">backup save</code> or <code className="text-zinc-400">backup restore</code> directly in your terminal session.
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}

function VersioningBanner({
  status,
  onRecheck,
}: {
  status: VersioningStatus;
  onRecheck: () => void;
}) {
  if (status.status === "enabled") return null;

  const variants = {
    limited: {
      icon: "⚠",
      title: `Point-in-time restore limited to ~${String(status.retentionDays ?? "?")} days`,
      body:
        "Your B2 bucket's lifecycle rules delete old file versions after this window. Backups older than this can't be fully restored — only files that still exist at that timestamp will come back.",
      cls: "border-amber-800/60 bg-amber-950/40 text-amber-200",
      iconCls: "text-amber-400",
    },
    disabled: {
      icon: "⛔",
      title: "Point-in-time restore unavailable",
      body:
        "Your B2 bucket deletes old file versions almost immediately, so restoring from an older backup won't work. To enable it, relax or remove the lifecycle rule on your bucket so old versions are retained.",
      cls: "border-red-900/60 bg-red-950/40 text-red-200",
      iconCls: "text-red-400",
    },
    unknown: {
      icon: "?",
      title: "Couldn't verify bucket versioning",
      body:
        "We couldn't read your B2 bucket's lifecycle settings. Point-in-time restore may or may not work — the API key needs permission to read bucket config, or the bucket may be unreachable.",
      cls: "border-zinc-700 bg-zinc-900 text-zinc-300",
      iconCls: "text-zinc-400",
    },
  } as const;

  const v = variants[status.status];

  return (
    <div className={`border rounded-xl p-4 ${v.cls}`}>
      <div className="flex items-start gap-3">
        <span className={`text-lg leading-none mt-0.5 ${v.iconCls}`}>{v.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">{v.title}</div>
          <p className="text-xs mt-1 opacity-90">{v.body}</p>
        </div>
        <button
          onClick={onRecheck}
          className="text-xs px-2 py-1 border border-current opacity-70 hover:opacity-100 rounded transition-opacity"
        >
          Re-check
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: BackupRun["status"] }) {
  const map = {
    running: { label: "Running", cls: "bg-blue-900/40 text-blue-300 border-blue-800" },
    success: { label: "Success", cls: "bg-green-900/30 text-green-300 border-green-900/60" },
    failed: { label: "Failed", cls: "bg-red-900/30 text-red-300 border-red-900/60" },
  };
  const s = map[status];
  return (
    <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider rounded border ${s.cls}`}>
      {s.label}
    </span>
  );
}
