import { useState, useEffect, useCallback } from "react";
import { api } from "../../lib/api.ts";

export interface WorkspaceRun {
  id: string;
  userId: string;
  kind: "save" | "restore";
  status: "running" | "success" | "failed";
  startedAt: number | string;
  endedAt: number | string | null;
  bytes: number | null;
  localPath: string | null;
  b2Path: string | null;
  trigger: string | null;
  error: string | null;
}

interface HistoryTableProps {
  reloadKey: number;
  onRestore: (run: WorkspaceRun) => void;
}

export function HistoryTable({ reloadKey, onRestore }: HistoryTableProps) {
  const [runs, setRuns] = useState<WorkspaceRun[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api("/api/admin/workspace-backup/runs");
      if (r.ok) {
        const j = (await r.json()) as { runs: WorkspaceRun[] };
        setRuns(j.runs);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => { void load(); }, [load, reloadKey]);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-zinc-800">
        <h3 className="text-sm font-semibold text-zinc-200">Backup history</h3>
      </div>

      {runs.length === 0 ? (
        <p className="px-5 py-4 text-sm text-zinc-500">No history yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800">
              <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">
                User
              </th>
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
            {runs.map((r) => {
              const filename = r.localPath?.split("/").pop();
              return (
                <FragmentRow
                  key={r.id}
                  run={r}
                  filename={filename}
                  expanded={expanded === r.id}
                  onToggleError={() =>
                    setExpanded((prev) => (prev === r.id ? null : r.id))
                  }
                  onRestore={() => onRestore(r)}
                />
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface FragmentRowProps {
  run: WorkspaceRun;
  filename: string | undefined;
  expanded: boolean;
  onToggleError: () => void;
  onRestore: () => void;
}

function FragmentRow({ run, filename, expanded, onToggleError, onRestore }: FragmentRowProps) {
  return (
    <>
      <tr className="border-b border-zinc-800/50 last:border-0">
        <td className="px-4 py-3 text-zinc-300 truncate max-w-xs">{run.userId}</td>
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
              onClick={onToggleError}
              className="ml-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              {expanded ? "hide" : "details"}
            </button>
          )}
        </td>
        <td className="px-4 py-3 text-zinc-300">
          {new Date(run.startedAt).toLocaleString()}
        </td>
        <td className="px-4 py-3 text-zinc-400">
          {run.bytes != null ? `${(run.bytes / 1024 / 1024).toFixed(1)} MB` : "—"}
        </td>
        <td className="px-4 py-3 text-right">
          <div className="flex justify-end gap-3">
            {run.kind === "save" && run.localPath && filename && (
              <a
                href={`/api/admin/workspace-backup/download/${run.userId}/${filename}`}
                className="text-xs text-purple-400 hover:text-purple-300 transition-colors"
              >
                Download
              </a>
            )}
            <button
              onClick={onRestore}
              className="text-xs text-amber-400 hover:text-amber-300 transition-colors"
            >
              Restore
            </button>
          </div>
        </td>
      </tr>
      {expanded && run.error && (
        <tr className="border-b border-zinc-800/50 last:border-0">
          <td colSpan={6} className="px-4 py-3">
            <pre className="text-xs bg-zinc-950 border border-red-800/40 p-3 rounded-lg
              overflow-auto text-red-300 font-mono">
              {run.error}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
