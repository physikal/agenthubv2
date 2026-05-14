import { useState } from "react";
import { api } from "../../lib/api.js";

type SourceKind = "history" | "b2-timestamp";

interface ValidateResult {
  ok: boolean;
  manifest?: {
    sourceDomain: string;
    createdAt: string;
    gitSha: string;
  };
  conflicts?: Array<{ kind: string; detail: string }>;
  error?: string;
}

export function RestoreCard() {
  const [sourceKind, setSourceKind] = useState<SourceKind>("history");
  const [historyPath, setHistoryPath] = useState("");
  const [b2Timestamp, setB2Timestamp] = useState("");
  const [validate, setValidate] = useState<ValidateResult | null>(null);
  const [confirmDomain, setConfirmDomain] = useState("");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [validating, setValidating] = useState(false);

  function buildSource() {
    if (sourceKind === "history") return { kind: "local", path: historyPath };
    return { kind: "b2-snapshot", snapshot: b2Timestamp || "latest" };
  }

  async function runValidate() {
    const source = buildSource();
    setValidate(null);
    setValidating(true);
    try {
      const r = await api("/api/admin/install-backup/restore/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      setValidate((await r.json()) as ValidateResult);
    } catch (err) {
      setValidate({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setValidating(false);
    }
  }

  async function runRestore() {
    const source = buildSource();
    if (!validate?.manifest) return;
    if (confirmDomain !== validate.manifest.sourceDomain) {
      alert(`Type the source domain (${validate.manifest.sourceDomain}) to confirm.`);
      return;
    }
    setRunning(true);
    setLog([]);
    try {
      const res = await api("/api/admin/install-backup/restore/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Confirm-Restore": "yes-i-know-what-this-does",
        },
        body: JSON.stringify({ source, force: !validate.ok }),
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
          if (event === "done") setRunning(false);
          if (event === "error") {
            setLog((prev) => [...prev, `ERROR: ${data}`]);
            setRunning(false);
          }
        }
      }
    } catch (err) {
      setLog((prev) => [...prev, `ERROR: ${err instanceof Error ? err.message : String(err)}`]);
      setRunning(false);
    }
  }

  return (
    <div className="bg-zinc-900 border border-amber-600/40 rounded-xl p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-amber-400">Restore</h3>
        <p className="text-xs text-zinc-500 mt-1">
          Restoring overwrites current install state. All users, sessions, and secrets will be
          replaced with those from the bundle.
        </p>
      </div>

      <div className="space-y-3 text-sm">
        <label className="flex items-center gap-2 cursor-pointer text-zinc-300">
          <input
            type="radio"
            className="accent-purple-500"
            checked={sourceKind === "history"}
            onChange={() => setSourceKind("history")}
          />
          From local path (paste path from history)
        </label>
        {sourceKind === "history" && (
          <input
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm
              focus:border-purple-500 focus:outline-none text-zinc-200"
            placeholder="/data/install-backups/install-example.tar.gz"
            value={historyPath}
            onChange={(e) => setHistoryPath(e.target.value)}
          />
        )}

        <label className="flex items-center gap-2 cursor-pointer text-zinc-300">
          <input
            type="radio"
            className="accent-purple-500"
            checked={sourceKind === "b2-timestamp"}
            onChange={() => setSourceKind("b2-timestamp")}
          />
          Pull from B2 by snapshot
        </label>
        {sourceKind === "b2-timestamp" && (
          <input
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm
              focus:border-purple-500 focus:outline-none text-zinc-200"
            placeholder="latest"
            value={b2Timestamp}
            onChange={(e) => setB2Timestamp(e.target.value)}
          />
        )}
      </div>

      <div className="flex gap-3">
        <button
          className="px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm
            hover:bg-zinc-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={validating}
          onClick={() => void runValidate()}
        >
          {validating ? "Validating..." : "Dry-run validate"}
        </button>
      </div>

      {validate && (
        <div className="text-sm space-y-2">
          {validate.error && (
            <p className="text-red-400">Validation failed: {validate.error}</p>
          )}
          {validate.manifest && (
            <div className="space-y-2">
              <p className="text-zinc-300">
                Bundle from{" "}
                <code className="text-purple-400">{validate.manifest.sourceDomain}</code>
                {" at "}
                {new Date(validate.manifest.createdAt).toLocaleString()}
                {" — git: "}
                <code className="text-zinc-500">{validate.manifest.gitSha.slice(0, 8)}</code>
              </p>

              {validate.conflicts && validate.conflicts.length > 0 && (
                <div className="bg-red-950/30 border border-red-800/40 rounded-lg p-3 space-y-1">
                  <p className="text-red-400 font-medium text-xs uppercase tracking-wider">
                    Conflicts
                  </p>
                  <ul className="space-y-1">
                    {validate.conflicts.map((c, i) => (
                      <li key={i} className="text-red-300 text-xs">
                        <span className="font-medium">{c.kind}:</span> {c.detail}
                      </li>
                    ))}
                  </ul>
                  <p className="text-zinc-500 text-xs mt-1">
                    Restore will proceed with force=true if you continue.
                  </p>
                </div>
              )}

              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Type{" "}
                  <code className="text-purple-400">{validate.manifest.sourceDomain}</code>
                  {" "}to confirm:
                </label>
                <input
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm
                    focus:border-red-500 focus:outline-none text-zinc-200"
                  value={confirmDomain}
                  onChange={(e) => setConfirmDomain(e.target.value)}
                />
              </div>

              <button
                className="px-4 py-2 bg-red-700 text-white rounded-lg text-sm font-medium
                  hover:bg-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={confirmDomain !== validate.manifest.sourceDomain || running}
                onClick={() => void runRestore()}
              >
                {running ? "Restoring..." : "Restore"}
              </button>
            </div>
          )}
        </div>
      )}

      {log.length > 0 && (
        <pre className="text-xs bg-zinc-950 border border-zinc-800 p-3 rounded-lg
          max-h-64 overflow-auto text-zinc-300 font-mono">
          {log.join("\n")}
        </pre>
      )}
    </div>
  );
}
