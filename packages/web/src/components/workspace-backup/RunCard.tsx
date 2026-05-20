import { useState, useEffect, useCallback } from "react";
import { api } from "../../lib/api.ts";
import { streamRun } from "../../lib/sse.ts";

interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
  createdAt: string;
}

interface RunCardProps {
  onChanged: () => void;
}

const ALL = "__all__";

export function RunCard({ onChanged }: RunCardProps) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [sel, setSel] = useState<string>(ALL);
  const [noB2, setNoB2] = useState(false);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await api("/api/admin/users");
      if (res.ok) {
        setUsers((await res.json()) as AdminUser[]);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => { void fetchUsers(); }, [fetchUsers]);

  async function runBackup() {
    setRunning(true);
    setLog([]);
    const body = sel === ALL ? { all: true, noB2 } : { userId: sel, noB2 };
    await streamRun("/api/admin/workspace-backup/run", body, {
      onLog: (l) => setLog((p) => [...p, l]),
      onDone: () => { setRunning(false); onChanged(); },
      onError: (e) => { setLog((p) => [...p, `ERROR: ${e}`]); setRunning(false); },
    });
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-200">Run backup</h3>
        <button
          className="px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm font-medium
            hover:bg-zinc-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={running}
          onClick={() => void runBackup()}
        >
          {running ? "Backing up..." : "Back up"}
        </button>
      </div>

      <div className="space-y-3 text-sm">
        <div>
          <label className="block text-xs text-zinc-500 mb-1">User</label>
          <select
            value={sel}
            onChange={(e) => setSel(e.target.value)}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm
              focus:border-purple-500 focus:outline-none text-zinc-200"
          >
            <option value={ALL}>All users</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username}
              </option>
            ))}
          </select>
        </div>

        <label className="flex items-center gap-2 cursor-pointer text-zinc-300">
          <input
            type="checkbox"
            className="accent-purple-500"
            checked={noB2}
            onChange={(e) => setNoB2(e.target.checked)}
          />
          Local only — skip B2
        </label>
      </div>

      {log.length > 0 && (
        <pre className="text-xs bg-zinc-950 border border-zinc-800 p-3 rounded-lg
          max-h-48 overflow-auto text-zinc-300 font-mono">
          {log.join("\n")}
        </pre>
      )}
    </div>
  );
}
