import type { Session } from "../stores/sessions.ts";

interface SessionCardProps {
  session: Session;
  selected: boolean;
  onClick: () => void;
  onDelete?: () => void;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${String(mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${String(hours)}h ${String(mins % 60)}m ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

function statusIcon(status: string): string {
  switch (status) {
    case "active":
      return "▶";
    case "waiting_login":
      return "🔑";
    case "waiting_input":
      return "⏸";
    case "completed":
      return "✓";
    case "failed":
      return "✕";
    case "creating":
    case "starting":
      return "◌";
    default:
      return "●";
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "active":
      return "text-green-400";
    case "waiting_login":
      return "text-orange-400";
    case "waiting_input":
      return "text-yellow-400";
    case "completed":
      return "text-zinc-400";
    case "failed":
      return "text-red-400";
    case "creating":
    case "starting":
      return "text-blue-400";
    default:
      return "text-zinc-500";
  }
}

function dotColor(status: string): string {
  switch (status) {
    case "active":
      return "bg-green-400";
    case "waiting_login":
      return "bg-orange-400";
    case "waiting_input":
      return "bg-yellow-400";
    case "creating":
    case "starting":
      return "bg-blue-400";
    default:
      return "bg-zinc-600";
  }
}

export function SessionCard({ session, selected, onClick, onDelete }: SessionCardProps) {
  const isActive = [
    "creating",
    "starting",
    "active",
    "waiting_input",
    "idle",
  ].includes(session.status);

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-4 rounded-xl border transition-all overflow-hidden ${
        selected
          ? "border-purple-500 bg-purple-500/5"
          : "border-zinc-800 bg-zinc-900 hover:border-zinc-700"
      }`}
    >
      <div className="flex items-start justify-between mb-2">
        <h4 className="font-medium text-zinc-100">{session.name}</h4>
        {isActive && (
          <span
            className={`w-2.5 h-2.5 rounded-full ${dotColor(session.status)} ${
              session.status === "active" ? "animate-pulse" : ""
            }`}
          />
        )}
      </div>
      <p className="text-xs text-zinc-500 mb-2">
        {isActive ? "Started" : "Finished"} {timeAgo(session.createdAt)}
      </p>
      <div className="flex items-center justify-between min-w-0">
        <div className="flex items-center gap-1.5 px-2 py-1 bg-zinc-800/50 rounded text-xs font-mono min-w-0 flex-1 mr-2">
          <span className={`shrink-0 ${statusColor(session.status)}`}>
            {statusIcon(session.status)}
          </span>
          <span className="text-zinc-400 truncate">
            {session.statusDetail || session.status}
          </span>
        </div>
        {!isActive && onDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="ml-2 px-2 py-1 text-[10px] text-zinc-500 hover:text-red-400 transition-colors"
            title="Delete session"
          >
            ✕
          </button>
        )}
      </div>
    </button>
  );
}
