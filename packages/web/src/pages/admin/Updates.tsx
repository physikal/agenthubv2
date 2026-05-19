import { AgentHubPanel } from "../../components/updates/AgentHubPanel.tsx";
import { ImagePinsTable } from "../../components/updates/ImagePinsTable.tsx";

export function UpdatesPage(): JSX.Element {
  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-semibold">Updates</h2>
        <p className="mt-1 text-sm text-zinc-500">
          System update visibility and apply actions.
        </p>
      </div>
      <div className="space-y-6">
        <AgentHubPanel />
        <ImagePinsTable />
      </div>
    </div>
  );
}
