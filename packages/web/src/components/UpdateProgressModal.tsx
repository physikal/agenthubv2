// Progress modal for the Settings → "Update now" flow.
//
// The update pipeline is opaque from the browser — the updater runs in a
// detached container, writes to docker's default log, and the only
// observable signals are `git rev-parse HEAD` and the server process's
// own `serverStartedAt`. This component maps those signals onto the four
// phases users actually care about so "what's happening right now?" is
// visible instead of a 3-minute guessing game.
//
// Phase transitions (monotonic, never regress):
//   pulling    → building   when the /repo SHA moves (git reset --hard)
//   building   → restarting when /api/admin/version starts failing
//                           (compose up --force-recreate killed the server)
//   restarting → done       when /api/admin/version succeeds again with
//                           a new serverStartedAt AND the target SHA
//   any        → failed     after the caller's timeout (5 min in Settings)
import type { ReactNode } from "react";

export type UpdatePhase =
  | "pulling"
  | "building"
  | "restarting"
  | "done"
  | "failed";

interface Props {
  readonly phase: UpdatePhase;
  readonly fromSha: string;
  readonly toSha: string;
  readonly errorMessage?: string;
  readonly onHide: () => void;
  readonly onReload: () => void;
}

interface Step {
  readonly id: Exclude<UpdatePhase, "failed">;
  readonly label: string;
  readonly hint?: string;
}

const STEPS: readonly Step[] = [
  { id: "pulling", label: "Fetching latest code", hint: "git fetch + reset to origin/main" },
  { id: "building", label: "Rebuilding image", hint: "docker build — typically 1-3 minutes" },
  { id: "restarting", label: "Restarting server", hint: "compose up --force-recreate" },
  { id: "done", label: "Ready" },
];

const PHASE_RANK: Record<UpdatePhase, number> = {
  pulling: 0,
  building: 1,
  restarting: 2,
  done: 3,
  failed: -1,
};

type StepStatus = "done" | "current" | "pending" | "failed";

function stepStatus(step: Step["id"], phase: UpdatePhase): StepStatus {
  if (phase === "failed") {
    // We can't tell which step failed without more bookkeeping — mark
    // nothing as failed in the checklist and let the error message below
    // carry the detail. Keep what had completed as ✓.
    return "pending";
  }
  if (phase === "done") return "done";
  const phaseRank = PHASE_RANK[phase];
  const stepRank = PHASE_RANK[step];
  if (phaseRank > stepRank) return "done";
  if (phaseRank === stepRank) return "current";
  return "pending";
}

export function UpdateProgressModal({
  phase,
  fromSha,
  toSha,
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-progress-title"
    >
      <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-4 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 id="update-progress-title" className="text-lg font-semibold text-zinc-100">
            {title}
          </h2>
          <code className="text-[10px] text-zinc-500 mt-1.5">
            {fromSha} → {toSha}
          </code>
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
