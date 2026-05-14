import { useState, useEffect, useCallback } from "react";
import { api } from "../../lib/api.js";

interface LastRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  bytes: number | null;
  b2Path: string | null;
  localPath: string | null;
}

export function BackupCard() {
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const r = await api("/api/admin/install-backup");
      if (r.ok) {
        const j = (await r.json()) as { lastRun: LastRun | null };
        setLastRun(j.lastRun);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function runBackup() {
    setRunning(true);
    setLog([]);
    try {
      const res = await api("/api/admin/install-backup/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) {
          const lines = p.split("\n");
          const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
          const data = lines
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("\n");
          if (event === "log") setLog((prev) => [...prev, data]);
          if (event === "done") { setRunning(false); void refresh(); }
          if (event === "error") { setLog((prev) => [...prev, `ERROR: ${data}`]); setRunning(false); }
        }
      }
    } catch (err) {
      setLog((prev) => [...prev, `ERROR: ${err instanceof Error ? err.message : String(err)}`]);
      setRunning(false);
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-200">Last backup</h3>
        <button
          className="px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm font-medium
            hover:bg-zinc-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={running}
          onClick={() => void runBackup()}
        >
          {running ? "Backing up..." : "Backup now"}
        </button>
      </div>

      {lastRun ? (
        <div className="text-sm space-y-1">
          <p className="text-zinc-400">
            {new Date(lastRun.startedAt).toLocaleString()}
            {" — "}
            <span className={lastRun.status === "ok" ? "text-green-400" : "text-red-400"}>
              {lastRun.status}
            </span>
            {lastRun.bytes != null
              ? ` — ${(lastRun.bytes / 1024 / 1024).toFixed(1)} MB`
              : ""}
          </p>
          {lastRun.localPath && (
            <p className="text-xs text-zinc-600 truncate">{lastRun.localPath}</p>
          )}
          {lastRun.b2Path && (
            <p className="text-xs text-zinc-600 truncate">{lastRun.b2Path}</p>
          )}
        </div>
      ) : (
        <p className="text-sm text-zinc-500">No backups yet.</p>
      )}

      {log.length > 0 && (
        <pre className="text-xs bg-zinc-950 border border-zinc-800 p-3 rounded-lg
          max-h-48 overflow-auto text-zinc-300 font-mono">
          {log.join("\n")}
        </pre>
      )}
    </div>
  );
}
