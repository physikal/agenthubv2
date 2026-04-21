import { useEffect, useState, useCallback } from "react";
import { useSessionStore } from "../stores/sessions.ts";
import { SessionCard } from "../components/SessionCard.tsx";
import { TerminalView } from "../components/Terminal.tsx";
import { NewSessionDialog } from "../components/NewSessionDialog.tsx";

export function Sessions() {
  const {
    active,
    completed,
    older,
    selectedId,
    fetchSessions,
    selectSession,
    endSession,
    deleteSession,
  } = useSessionStore();
  const [showDialog, setShowDialog] = useState(false);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    void fetchSessions();
    if (terminalSessionId) return;
    const interval = setInterval(() => void fetchSessions(), 5_000);
    return () => clearInterval(interval);
  }, [fetchSessions, terminalSessionId]);

  const openTerminal = useCallback((id: string) => {
    selectSession(id);
    setTerminalSessionId(id);
  }, [selectSession]);

  const closeTerminal = useCallback(() => {
    setTerminalSessionId(null);
    selectSession(null);
    setFullScreen(false);
    void fetchSessions();
  }, [selectSession, fetchSessions]);

  const handleEndSession = useCallback(async () => {
    if (!terminalSessionId) return;
    await endSession(terminalSessionId);
    setShowEndConfirm(false);
    closeTerminal();
  }, [terminalSessionId, endSession, closeTerminal]);

  const selectedSession =
    [...active, ...completed].find((s) => s.id === terminalSessionId) ?? null;

  // Terminal panel — fills entire main area
  if (terminalSessionId && selectedSession) {
    return (
      <div className={`flex flex-col h-full ${fullScreen ? "fixed inset-0 z-50 bg-zinc-950" : ""}`}>
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-900 shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={closeTerminal}
              className="text-zinc-400 hover:text-zinc-100 transition-colors text-sm"
            >
              ✕ Close
            </button>
            <span className="text-sm font-medium text-zinc-200">
              {selectedSession.name}
            </span>
            {selectedSession.lxcNode && (
              <span className="text-xs text-zinc-500">
                lxc-{selectedSession.lxcNode}-{String(selectedSession.lxcVmid)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setRefreshKey((k) => k + 1)}
              className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded transition-colors"
              title="Redraw terminal"
            >
              ↻
            </button>
            <button
              onClick={() => setFullScreen(!fullScreen)}
              className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded transition-colors"
            >
              {fullScreen ? "Exit fullscreen" : "Fullscreen"}
            </button>
            <button
              onClick={() => setShowEndConfirm(true)}
              className="px-3 py-1.5 text-xs text-red-400 border border-red-600/30 rounded hover:bg-red-600/10 transition-colors"
            >
              End session
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <TerminalView
            key={`${terminalSessionId}-${String(refreshKey)}`}
            sessionId={terminalSessionId}
          />
        </div>

        {showEndConfirm && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-sm bg-zinc-900 border border-zinc-700 rounded-2xl p-6">
              <h3 className="text-lg font-semibold mb-2">End session?</h3>
              <p className="text-sm text-zinc-400 mb-5">
                This will destroy the container. Your files in /home/coder are saved, but any running processes will be stopped.
              </p>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setShowEndConfirm(false)}
                  className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleEndSession()}
                  className="px-4 py-2 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-500 transition-colors"
                >
                  End session
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Dashboard — scrollable with padding
  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-semibold">My sessions</h2>
        <button
          onClick={() => setShowDialog(true)}
          className="px-5 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm font-medium hover:bg-zinc-700 transition-colors"
        >
          + New session
        </button>
      </div>

      {active.length > 0 && (
        <section className="mb-6">
          <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
            Active
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {active.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                selected={false}
                onClick={() => openTerminal(s.id)}
              />
            ))}
          </div>
        </section>
      )}

      {completed.length > 0 && (
        <section className="mb-6">
          <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
            Earlier today
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {completed.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                selected={false}
                onClick={() => {}}
                onDelete={() => void deleteSession(s.id)}
              />
            ))}
          </div>
        </section>
      )}

      {older.length > 0 && (
        <section className="mb-6">
          <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
            Previous
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {older.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                selected={false}
                onClick={() => {}}
                onDelete={() => void deleteSession(s.id)}
              />
            ))}
          </div>
        </section>
      )}

      {active.length === 0 && completed.length === 0 && older.length === 0 && (
        <div className="flex-1 flex items-center justify-center text-zinc-500 min-h-[300px]">
          <div className="text-center">
            <p className="text-lg mb-2">No sessions yet</p>
            <p className="text-sm">Click "+ New session" to start a coding session</p>
          </div>
        </div>
      )}

      <NewSessionDialog open={showDialog} onClose={() => setShowDialog(false)} />
    </div>
  );
}
