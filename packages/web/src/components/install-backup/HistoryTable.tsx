import { useState, useEffect, useCallback } from "react";
import { api } from "../../lib/api.js";

interface Run {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  bytes: number | null;
  localPath: string | null;
  b2Path: string | null;
  trigger: string;
  note: string | null;
}

export function HistoryTable() {
  const [runs, setRuns] = useState<Run[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await api("/api/admin/install-backup/runs");
      if (r.ok) {
        const j = (await r.json()) as { runs: Run[] };
        setRuns(j.runs);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

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
                Started
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">
                Status
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">
                Size
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">
                Destinations
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">
                Trigger
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">
                Note
              </th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-b border-zinc-800/50 last:border-0">
                <td className="px-4 py-3 text-zinc-300">
                  {new Date(r.startedAt).toLocaleString()}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      r.status === "ok"
                        ? "bg-green-500/10 text-green-400"
                        : r.status === "running"
                          ? "bg-blue-500/10 text-blue-400"
                          : "bg-red-500/10 text-red-400"
                    }`}
                  >
                    {r.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-zinc-400">
                  {r.bytes != null ? `${(r.bytes / 1024 / 1024).toFixed(1)} MB` : "—"}
                </td>
                <td className="px-4 py-3 text-zinc-400">
                  {[r.localPath ? "Local" : null, r.b2Path ? "B2" : null]
                    .filter(Boolean)
                    .join(", ") || "—"}
                </td>
                <td className="px-4 py-3 text-zinc-400">{r.trigger}</td>
                <td className="px-4 py-3 text-zinc-500 truncate max-w-xs">{r.note ?? ""}</td>
                <td className="px-4 py-3 text-right">
                  {r.localPath && (
                    <a
                      href={`/api/admin/install-backup/runs/${r.id}/download`}
                      className="text-xs text-purple-400 hover:text-purple-300 transition-colors"
                    >
                      Download
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
