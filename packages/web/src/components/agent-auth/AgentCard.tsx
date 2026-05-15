import type { AgentStatus } from "./useAgentStatus.js";

interface Props {
  tool: AgentStatus;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function AgentCard({ tool, onConnect, onDisconnect }: Props) {
  const connected = tool.status === "connected";
  const expiry = tool.expiresAt ? new Date(tool.expiresAt).toLocaleDateString() : null;
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-zinc-500"}`} />
        <h3 className="font-medium text-zinc-100">{tool.displayName}</h3>
      </div>
      <p className="text-xs text-zinc-500 mb-3">
        {connected ? (
          <>
            <span className="text-green-400">Connected</span>
            {expiry && <span> · expires {expiry}</span>}
          </>
        ) : (
          "Not connected"
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {connected ? (
          <>
            <button
              type="button"
              onClick={onConnect}
              className="px-3 py-1.5 text-xs text-zinc-300 border border-zinc-700 rounded-lg hover:bg-zinc-800 transition-colors"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={onDisconnect}
              className="px-3 py-1.5 text-xs text-red-400 border border-zinc-700 rounded-lg hover:bg-zinc-800 transition-colors"
            >
              Disconnect
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onConnect}
            className="px-3 py-1.5 text-xs text-zinc-100 bg-blue-600 border border-blue-600 rounded-lg hover:bg-blue-500 transition-colors"
          >
            Connect
          </button>
        )}
      </div>
    </div>
  );
}
