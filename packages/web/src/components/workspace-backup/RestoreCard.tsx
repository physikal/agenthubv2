import { useState, useEffect } from "react";
import { streamRun } from "../../lib/sse.ts";
import type { WorkspaceRun } from "./HistoryTable.tsx";

type SourceKind = "b2-snapshot" | "local";

interface RestoreCardProps {
  target: WorkspaceRun | null;
  onChanged: () => void;
}

export function RestoreCard({ target, onChanged }: RestoreCardProps) {
  const [userId, setUserId] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind>("b2-snapshot");
  const [snapshot, setSnapshot] = useState("latest");
  const [filename, setFilename] = useState("");
  const [force, setForce] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    if (!target) return;
    setUserId(target.userId);
    if (target.kind === "save" && target.localPath) {
      setSourceKind("local");
      setFilename(target.localPath.split("/").pop() ?? "");
    }
  }, [target]);

  async function runRestore() {
    const source =
      sourceKind === "b2-snapshot"
        ? { kind: "b2-snapshot" as const, snapshot: snapshot || "latest" }
        : { kind: "local" as const, filename };
    setRunning(true);
    setLog([]);
    await streamRun(
      "/api/admin/workspace-backup/restore/run",
      { userId, source, force },
      {
        onLog: (l) => setLog((p) => [...p, l]),
        onDone: () => { setRunning(false); onChanged(); },
        onError: (e) => { setLog((p) => [...p, `ERROR: ${e}`]); setRunning(false); },
      },
      { "Confirm-Restore": "yes-i-know-what-this-does" },
    );
  }

  const canSubmit = userId.trim() !== "" && confirm && !running;

  return (
    <div className="bg-zinc-900 border border-amber-600/40 rounded-xl p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-amber-400">Restore</h3>
        <p className="text-xs text-zinc-500 mt-1">
          Restoring overwrites the user&apos;s /home/coder with the contents of the bundle.
          The user must end their active sessions first.
        </p>
      </div>

      <div className="space-y-3 text-sm">
        <div>
          <label className="block text-xs text-zinc-500 mb-1">User ID</label>
          <input
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm
              focus:border-purple-500 focus:outline-none text-zinc-200"
            placeholder="user id"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          />
        </div>

        <label className="flex items-center gap-2 cursor-pointer text-zinc-300">
          <input
            type="radio"
            className="accent-purple-500"
            checked={sourceKind === "b2-snapshot"}
            onChange={() => setSourceKind("b2-snapshot")}
          />
          Pull from B2 by snapshot
        </label>
        {sourceKind === "b2-snapshot" && (
          <input
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm
              focus:border-purple-500 focus:outline-none text-zinc-200"
            placeholder="latest"
            value={snapshot}
            onChange={(e) => setSnapshot(e.target.value)}
          />
        )}

        <label className="flex items-center gap-2 cursor-pointer text-zinc-300">
          <input
            type="radio"
            className="accent-purple-500"
            checked={sourceKind === "local"}
            onChange={() => setSourceKind("local")}
          />
          From local file
        </label>
        {sourceKind === "local" && (
          <input
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm
              focus:border-purple-500 focus:outline-none text-zinc-200"
            placeholder="workspace-example.tar.gz"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
          />
        )}

        <label className="flex items-center gap-2 cursor-pointer text-zinc-300">
          <input
            type="checkbox"
            className="accent-purple-500"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
          />
          Force (override conflict guard)
        </label>

        <label className="flex items-start gap-2 cursor-pointer text-zinc-300">
          <input
            type="checkbox"
            className="accent-red-500 mt-0.5"
            checked={confirm}
            onChange={(e) => setConfirm(e.target.checked)}
          />
          <span className="text-xs">
            I understand this replaces the user&apos;s /home/coder, and the user must end their
            active sessions first.
          </span>
        </label>
      </div>

      <button
        className="px-4 py-2 bg-red-700 text-white rounded-lg text-sm font-medium
          hover:bg-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        disabled={!canSubmit}
        onClick={() => void runRestore()}
      >
        {running ? "Restoring..." : "Restore"}
      </button>

      {log.length > 0 && (
        <pre className="text-xs bg-zinc-950 border border-zinc-800 p-3 rounded-lg
          max-h-64 overflow-auto text-zinc-300 font-mono">
          {log.join("\n")}
        </pre>
      )}
    </div>
  );
}
