import { Fragment, useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { streamRun } from "../lib/sse.ts";
import type { WorkspaceRun } from "../components/workspace-backup/HistoryTable.tsx";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export function Backups() {
  const [runs, setRuns] = useState<WorkspaceRun[]>([]);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Restore flow state: the snapshot the user picked, plus its confirm/log.
  const [restoreTarget, setRestoreTarget] = useState<WorkspaceRun | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreLog, setRestoreLog] = useState<string[]>([]);

  const reloadRuns = useCallback(async () => {
    try {
      const res = await api("/api/user/workspace-backup");
      if (res.ok) {
        const j = (await res.json()) as { runs: WorkspaceRun[] };
        setRuns(j.runs);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void reloadRuns();
  }, [reloadRuns]);

  function runBackup() {
    setRunning(true);
    setLog([]);
    void streamRun(
      "/api/user/workspace-backup/run",
      {},
      {
        onLog: (l) => setLog((p) => [...p, l]),
        onDone: () => {
          setRunning(false);
          void reloadRuns();
        },
        onError: (e) => {
          setLog((p) => [...p, `ERROR: ${e}`]);
          setRunning(false);
        },
      },
    );
  }

  function openRestore(run: WorkspaceRun) {
    setRestoreTarget(run);
    setRestoreConfirm(false);
    setRestoreLog([]);
  }

  function closeRestore() {
    setRestoreTarget(null);
    setRestoreConfirm(false);
    setRestoreLog([]);
  }

  function runRestore() {
    if (!restoreTarget) return;
    const filename = restoreTarget.localPath?.split("/").pop();
    if (!filename) return;
    setRestoring(true);
    setRestoreLog([]);
    void streamRun(
      "/api/user/workspace-backup/restore/run",
      { source: { kind: "local", filename }, force: true },
      {
        onLog: (l) => setRestoreLog((p) => [...p, l]),
        onDone: () => {
          setRestoring(false);
          void reloadRuns();
        },
        onError: (e) => {
          setRestoreLog((p) => [...p, `ERROR: ${e}`]);
          setRestoring(false);
        },
      },
      { "Confirm-Restore": "yes-i-know-what-this-does" },
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <h2 className="text-2xl font-semibold mb-2">Backups</h2>
      <p className="text-sm text-zinc-500 mb-6 max-w-3xl">
        Back up everything under your workspace home, except{" "}
        <code className="text-zinc-400">node_modules</code>,{" "}
        <code className="text-zinc-400">.cache</code>, and reinstallable CLI tools.
      </p>

      <div className="max-w-3xl space-y-6">
        {/* Run a backup */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-200">Back up my workspace now</h3>
            <button
              className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium
                hover:bg-purple-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={running}
              onClick={runBackup}
            >
              {running ? "Backing up..." : "Back up now"}
            </button>
          </div>

          {log.length > 0 && (
            <pre className="text-xs bg-zinc-950 border border-zinc-800 p-3 rounded-lg
              max-h-48 overflow-auto text-zinc-300 font-mono">
              {log.join("\n")}
            </pre>
          )}
        </div>

        {/* My snapshots */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-800">
            <h3 className="text-sm font-semibold text-zinc-200">My snapshots</h3>
          </div>

          {runs.length === 0 ? (
            <p className="px-5 py-4 text-sm text-zinc-500">
              No snapshots yet. Click &quot;Back up now&quot; to create one.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">
                    Kind
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">
                    Status
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">
                    Started
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">
                    Size
                  </th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const filename = run.localPath?.split("/").pop();
                  const isExpanded = expanded === run.id;
                  const canRestore = run.kind === "save" && run.localPath != null;
                  return (
                    <Fragment key={run.id}>
                      <tr className="border-b border-zinc-800/50 last:border-0">
                        <td className="px-4 py-3 text-zinc-400">{run.kind}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`text-xs px-2 py-0.5 rounded ${
                              run.status === "success"
                                ? "bg-green-500/10 text-green-400"
                                : run.status === "running"
                                  ? "bg-blue-500/10 text-blue-400"
                                  : "bg-red-500/10 text-red-400"
                            }`}
                          >
                            {run.status}
                          </span>
                          {run.status === "failed" && run.error && (
                            <button
                              onClick={() =>
                                setExpanded((prev) => (prev === run.id ? null : run.id))
                              }
                              className="ml-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                            >
                              {isExpanded ? "hide" : "details"}
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-3 text-zinc-300">
                          {new Date(run.startedAt).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-zinc-400">
                          {run.bytes != null ? formatBytes(run.bytes) : "—"}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex justify-end gap-3">
                            {canRestore && filename && (
                              <a
                                href={`/api/user/workspace-backup/download/${filename}`}
                                className="text-xs text-purple-400 hover:text-purple-300 transition-colors"
                              >
                                Download
                              </a>
                            )}
                            {canRestore && (
                              <button
                                onClick={() => openRestore(run)}
                                className="text-xs text-amber-400 hover:text-amber-300 transition-colors"
                              >
                                Restore
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {isExpanded && run.error && (
                        <tr className="border-b border-zinc-800/50 last:border-0">
                          <td colSpan={5} className="px-4 py-3">
                            <pre className="text-xs bg-zinc-950 border border-red-800/40 p-3 rounded-lg
                              overflow-auto text-red-300 font-mono">
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

        {/* Restore confirm */}
        {restoreTarget && (
          <div className="bg-zinc-900 border border-amber-600/40 rounded-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-amber-400">
                  Restore this snapshot
                </h3>
                <p className="text-xs text-zinc-400 mt-1">
                  {new Date(restoreTarget.startedAt).toLocaleString()}
                  {restoreTarget.bytes != null
                    ? ` · ${formatBytes(restoreTarget.bytes)}`
                    : ""}
                </p>
              </div>
              <button
                onClick={closeRestore}
                disabled={restoring}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50"
              >
                cancel
              </button>
            </div>

            <p className="text-xs text-amber-200 bg-amber-950/40 border border-amber-800/60 rounded-lg p-3">
              This <strong>replaces</strong> your workspace home with this snapshot. You must
              end your active sessions first — the restore will refuse otherwise.
            </p>

            <label className="flex items-start gap-2 cursor-pointer text-zinc-300">
              <input
                type="checkbox"
                className="accent-red-500 mt-0.5"
                checked={restoreConfirm}
                onChange={(e) => setRestoreConfirm(e.target.checked)}
              />
              <span className="text-xs">
                I understand this replaces my workspace home, and I have ended my active
                sessions.
              </span>
            </label>

            <button
              className="px-4 py-2 bg-red-700 text-white rounded-lg text-sm font-medium
                hover:bg-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={!restoreConfirm || restoring}
              onClick={runRestore}
            >
              {restoring ? "Restoring..." : "Restore this snapshot"}
            </button>

            {restoreLog.length > 0 && (
              <pre className="text-xs bg-zinc-950 border border-zinc-800 p-3 rounded-lg
                max-h-64 overflow-auto text-zinc-300 font-mono">
                {restoreLog.join("\n")}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
