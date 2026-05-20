import { useState } from "react";
import { RunCard } from "../../components/workspace-backup/RunCard.tsx";
import { HistoryTable } from "../../components/workspace-backup/HistoryTable.tsx";
import { RestoreCard } from "../../components/workspace-backup/RestoreCard.tsx";
import type { WorkspaceRun } from "../../components/workspace-backup/HistoryTable.tsx";

export function WorkspaceBackupPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const [restoreTarget, setRestoreTarget] = useState<WorkspaceRun | null>(null);

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-semibold">Workspace Backup</h2>
        <p className="text-sm text-zinc-500 mt-1">
          Back up and restore per-user workspace volumes — the contents of /home/coder.
        </p>
      </div>
      <div className="space-y-6">
        <RunCard onChanged={() => setReloadKey((k) => k + 1)} />
        <HistoryTable reloadKey={reloadKey} onRestore={setRestoreTarget} />
        <RestoreCard target={restoreTarget} onChanged={() => setReloadKey((k) => k + 1)} />
      </div>
    </div>
  );
}
