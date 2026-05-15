import { useEffect, useState, useCallback } from "react";

interface AuditRow {
  id: number;
  createdAt: string;
  userId: string;
  action: string;
  toolId: string;
  sessionId?: string;
  ok: boolean;
  error?: string;
}

export function AgentAuthAudit() {
  const [userId, setUserId] = useState("");
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchAudit = useCallback(async () => {
    if (!userId) return;
    setError(null);
    const r = await fetch(
      `/api/admin/agent-auth/audit?userId=${encodeURIComponent(userId)}&limit=200`,
      { credentials: "include" },
    );
    if (!r.ok) {
      setError(`HTTP ${String(r.status)}`);
      return;
    }
    const j = (await r.json()) as { rows: AuditRow[] };
    setRows(j.rows);
  }, [userId]);

  useEffect(() => {
    void fetchAudit();
  }, [fetchAudit]);

  return (
    <div className="flex-1 overflow-auto p-6">
      <h2 className="text-2xl font-semibold mb-4">Agent CLI Auth — Audit Log</h2>
      <div className="mb-4 flex items-center gap-2">
        <label className="text-sm text-zinc-400">User ID</label>
        <input
          type="text"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="paste a user id"
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm text-zinc-100 w-96"
        />
      </div>
      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-800/50 text-zinc-400 text-xs uppercase">
            <tr>
              <th className="text-left px-3 py-2">Time</th>
              <th className="text-left px-3 py-2">Action</th>
              <th className="text-left px-3 py-2">Tool</th>
              <th className="text-left px-3 py-2">Session</th>
              <th className="text-left px-3 py-2">OK</th>
              <th className="text-left px-3 py-2">Error</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center text-zinc-500 px-3 py-6">
                  {userId ? "No audit rows for this user." : "Enter a user ID above."}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-t border-zinc-800">
                  <td className="px-3 py-2 text-zinc-400">
                    {new Date(r.createdAt).toISOString()}
                  </td>
                  <td className="px-3 py-2 text-zinc-200">{r.action}</td>
                  <td className="px-3 py-2 text-zinc-200">{r.toolId}</td>
                  <td className="px-3 py-2 text-xs text-zinc-500 font-mono">
                    {r.sessionId ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    {r.ok ? (
                      <span className="text-green-400">ok</span>
                    ) : (
                      <span className="text-red-400">fail</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-red-400">{r.error ?? ""}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
