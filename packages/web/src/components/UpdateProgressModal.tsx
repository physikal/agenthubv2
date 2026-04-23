// Progress modal for the Settings → "Update now" flow.
//
// Pure render component — all polling, SSE subscription, and state
// management lives in VersionPanel (Settings.tsx). That split matters
// because the log stream has to keep running while the user has the
// modal hidden; if the EventSource lived here, toggling Hide would
// tear it down and the "is it still alive?" answer would be gone.
//
// Phase transitions (monotonic, never regress, enforced by PHASE_RANK):
//   pulling    → building   when the /repo SHA moves (git reset --hard)
//   building   → restarting when /api/admin/version starts failing
//                           (compose up --force-recreate killed the server)
//   restarting → done       when /api/admin/version succeeds again with
//                           a new serverStartedAt
//   any        → failed     after the caller's 20-min timeout
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export type UpdatePhase =
  | "pulling"
  | "building"
  | "restarting"
  | "done"
  | "failed";

// Monotonic rank — used by the polling reducer to reject out-of-order
// phase transitions so a transient network blip can't regress from
// "restarting" back to "building". `failed` is the highest so any
// phase → failed transition is always allowed.
export const PHASE_RANK: Record<UpdatePhase, number> = {
  pulling: 0,
  building: 1,
  restarting: 2,
  done: 3,
  failed: 99,
};

interface Step {
  readonly id: Exclude<UpdatePhase, "failed">;
  readonly label: string;
  readonly hint?: string;
}

export const STEPS: readonly Step[] = [
  { id: "pulling", label: "Fetching latest code", hint: "git fetch + reset to origin/main" },
  { id: "building", label: "Rebuilding images", hint: "docker build — typically 3-8 min, up to 15 on cold cache or slow disk" },
  { id: "restarting", label: "Restarting server", hint: "compose up --force-recreate" },
  { id: "done", label: "Ready" },
];

export type StepStatus = "done" | "current" | "pending" | "failed";

// When the overall phase is "failed", we mark the most-advanced non-
// terminal step as failed (with a red ✗) rather than leaving the whole
// checklist grey. Previously everything reset to "pending" on failure,
// which made the modal look like nothing had run at all.
export function stepStatus(step: Step["id"], phase: UpdatePhase): StepStatus {
  if (phase === "done") return "done";
  if (phase === "failed") {
    // Failure without a recorded sub-phase is rare (the reducer always
    // tracks through pulling → building → restarting). If it happens,
    // mark the first step as failed so the user sees where we got.
    return step === "pulling" ? "failed" : "pending";
  }
  const phaseRank = PHASE_RANK[phase];
  const stepRank = PHASE_RANK[step];
  if (phaseRank > stepRank) return "done";
  if (phaseRank === stepRank) return "current";
  return "pending";
}

interface Props {
  readonly phase: UpdatePhase;
  readonly fromSha: string;
  readonly toSha: string;
  readonly startedAt: number; // Date.now() captured when the update was kicked off
  readonly logLines: readonly string[];
  readonly streamState: "connecting" | "live" | "ended" | "error" | "idle";
  readonly errorMessage?: string;
  readonly onHide: () => void;
  readonly onReload: () => void;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${String(minutes)}m ${String(seconds).padStart(2, "0")}s`
    : `${String(seconds)}s`;
}

export function UpdateProgressModal({
  phase,
  fromSha,
  toSha,
  startedAt,
  logLines,
  streamState,
  errorMessage,
  onHide,
  onReload,
}: Props): ReactNode {
  const isDone = phase === "done";
  const isFailed = phase === "failed";
  const isTerminal = isDone || isFailed;

  const title = isDone
    ? "Update complete"
    : isFailed
      ? "Update failed"
      : "Updating AgentHub";

  // Tick the elapsed counter every second while the update is running
  // so users see it's still making progress. Freezes on terminal states
  // so the final duration stays visible.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (isTerminal) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isTerminal]);
  const elapsed = now - startedAt;

  // Auto-scroll the log pane to the bottom when new lines land — but
  // only if the user hasn't scrolled up manually, so reading mid-build
  // doesn't yank them back.
  const logEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = logEndRef.current;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    const nearBottom =
      parent.scrollHeight - parent.scrollTop - parent.clientHeight < 40;
    if (nearBottom) el.scrollIntoView({ block: "end" });
  }, [logLines]);

  const showLogPane = streamState !== "idle" && (logLines.length > 0 || streamState === "connecting");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-progress-title"
    >
      <div className="w-full max-w-xl bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <h2 id="update-progress-title" className="text-lg font-semibold text-zinc-100">
            {title}
          </h2>
          <div className="text-right">
            <code className="block text-[10px] text-zinc-500 mt-1.5">
              {fromSha} → {toSha}
            </code>
            <span className="text-[10px] text-zinc-600 tabular-nums">
              elapsed {formatElapsed(elapsed)}
            </span>
          </div>
        </div>

        <ol className="space-y-3">
          {STEPS.map((step) => {
            const status = stepStatus(step.id, phase);
            return (
              <li key={step.id} className="flex items-start gap-3 text-sm">
                <StepIcon status={status} />
                <div className="flex-1 min-w-0">
                  <p
                    className={
                      status === "pending"
                        ? "text-zinc-500"
                        : status === "current"
                          ? "text-zinc-100 font-medium"
                          : status === "failed"
                            ? "text-red-300 font-medium"
                            : "text-zinc-300"
                    }
                  >
                    {step.label}
                  </p>
                  {step.hint && status === "current" && (
                    <p className="text-xs text-zinc-500 mt-0.5">{step.hint}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {showLogPane && (
          <details className="group" open>
            <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300 select-none">
              Build log
              <span className="ml-2 text-zinc-600 font-mono">
                {streamState === "connecting" && "(connecting...)"}
                {streamState === "live" && `(${String(logLines.length)} lines · live)`}
                {streamState === "ended" && `(${String(logLines.length)} lines · stream ended)`}
                {streamState === "error" && "(stream unavailable)"}
              </span>
            </summary>
            <div className="mt-2 max-h-48 overflow-y-auto bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5">
              <pre className="text-[11px] leading-snug text-zinc-400 font-mono whitespace-pre-wrap break-all">
                {logLines.length === 0
                  ? <span className="text-zinc-600">waiting for output…</span>
                  : logLines.join("\n")}
              </pre>
              <div ref={logEndRef} />
            </div>
          </details>
        )}

        {isFailed && errorMessage && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
            <p className="text-sm text-red-400">{errorMessage}</p>
            <p className="text-xs text-zinc-500 mt-1">
              On the host: <code className="text-zinc-400">agenthub logs</code>
            </p>
          </div>
        )}

        {isDone && (
          <p className="text-xs text-zinc-400">
            Server is back up at <code className="text-zinc-200">{toSha}</code>. Reload to pick up the new UI.
          </p>
        )}

        {!isTerminal && (
          <p className="text-xs text-zinc-500">
            Leaving this open is fine — the update runs server-side. You can also hide this and come back; the Version panel will show the new SHA when it's done.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          {!isTerminal && (
            <button
              onClick={onHide}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Hide
            </button>
          )}
          {isFailed && (
            <button
              onClick={onHide}
              className="px-4 py-2 text-sm font-medium bg-zinc-700 text-white rounded-lg hover:bg-zinc-600 transition-colors"
            >
              Close
            </button>
          )}
          {isDone && (
            <button
              onClick={onReload}
              className="px-4 py-2 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-500 transition-colors"
              autoFocus
            >
              Reload now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StepIcon({ status }: { readonly status: StepStatus }): ReactNode {
  const base = "inline-flex items-center justify-center w-5 h-5 rounded-full text-xs shrink-0 mt-0.5";
  if (status === "done") {
    return (
      <span className={`${base} bg-green-500/20 text-green-400`} aria-label="done">
        ✓
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className={`${base} bg-red-500/20 text-red-400`} aria-label="failed">
        ✗
      </span>
    );
  }
  if (status === "current") {
    return (
      <span
        className={`${base} bg-purple-500/20 text-purple-400 animate-spin`}
        aria-label="in progress"
      >
        ◌
      </span>
    );
  }
  return (
    <span className={`${base} bg-zinc-800 text-zinc-600`} aria-label="pending">
      ○
    </span>
  );
}
