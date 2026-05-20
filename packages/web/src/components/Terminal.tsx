import { useTerminal } from "../hooks/useTerminal.ts";

interface TerminalProps {
  sessionId: string;
}

const DOT: Record<string, string> = {
  uploading: "bg-amber-400 animate-pulse",
  done: "bg-green-400",
  error: "bg-red-400",
};

const STATUS_TEXT: Record<string, string> = {
  uploading: "uploading…",
  done: "attached",
  error: "failed",
};

export function TerminalView({ sessionId }: TerminalProps) {
  const { attach, uploads } = useTerminal({ sessionId });

  return (
    <div className="relative h-full w-full bg-[#1a1a2e]">
      <div ref={attach} className="h-full w-full" />
      {uploads.length > 0 && (
        <div className="absolute bottom-3 right-3 flex flex-col items-end gap-1.5 pointer-events-none">
          {uploads.map((u) => (
            <div
              key={u.id}
              className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900/95 px-3 py-1.5 text-xs text-zinc-200 shadow-lg"
            >
              <span className={`h-2 w-2 rounded-full ${DOT[u.status] ?? "bg-zinc-500"}`} />
              <span className="font-medium">{u.label}</span>
              <span className="text-zinc-500">{STATUS_TEXT[u.status] ?? ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
