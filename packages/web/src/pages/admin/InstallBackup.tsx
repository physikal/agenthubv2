import { BackupCard } from "../../components/install-backup/BackupCard.js";
import { B2ConfigCard } from "../../components/install-backup/B2ConfigCard.js";
import { HistoryTable } from "../../components/install-backup/HistoryTable.js";
import { RestoreCard } from "../../components/install-backup/RestoreCard.js";

export function InstallBackupPage() {
  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-semibold">Install Backup</h2>
        <p className="text-sm text-zinc-500 mt-1">
          Backup and restore install state — compose/.env, SQLite database, and Infisical data.
        </p>
      </div>
      <div className="space-y-6">
        <BackupCard />
        <B2ConfigCard />
        <HistoryTable />
        <RestoreCard />
      </div>
    </div>
  );
}
