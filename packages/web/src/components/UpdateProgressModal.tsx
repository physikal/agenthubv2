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
import { useEffect, useRef, useState } from "react";
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
  readonly startedAt: number; // Date.now() captured when the update was kicked off
  readonly containerName?: string; // agenthub-updater-<id>, used for log stream
  readonly errorMessage?: string;
  readonly onHide: () => void;
  readonly onReload: () => void;
}

// Cap so a multi-minute build doesn't turn the modal into an endlessly-
// growing DOM tree. The stream keeps flowing server-side; we just ring-
// buffer on the client.
const MAX_LOG_LINES = 200;

// Strip ANSI escape codes so colored docker-build output renders as plain
// text rather than leaking literal escape sequences into the modal. We
// don't try to render the colors — a build log in a <pre> is readable
// enough without them, and an ANSI parser pulls in more weight than the
// UX gain is worth.
function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

interface Step {
  readonly id: Exclude<UpdatePhase, "failed">;
  readonly label: string;
  readonly hint?: string;
}

const STEPS: readonly Step[] = [
  { id: "pulling", label: "Fetching latest code", hint: "git fetch + reset to origin/main" },
  { id: "building", label: "Rebuilding images", hint: "docker build — typically 3-8 min, up to 15 on cold cache or slow disk" },
  { id: "restarting", label: "Restarting server", hint: "compose up --force-recreate" },
  { id: "done", label: "Ready" },
];

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${String(minutes)}m ${String(seconds).padStart(2, "0")}s` : `${String(seconds)}s`;
}

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
  startedAt,
  containerName,
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

  // Tick the elapsed counter every second while the update is running so
  // users can see it's still making progress. Freezes on terminal states
  // so the final duration stays visible.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (isTerminal) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isTerminal]);
  const elapsed = now - startedAt;

  // Live log stream from /api/admin/update/logs. Connection is best-
  // effort — it'll die when compose recreates the server, and that's
  // fine (phase state machine in Settings.tsx handles completion
  // detection independently). When it dies we just stop appending
  // lines and show a "stream ended" footer; the modal still works.
  const [logLines, setLogLines] = useState<readonly string[]>([]);
  const [streamState, setStreamState] = useState<"connecting" | "live" | "ended" | "error">("connecting");
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerName || isTerminal) return;
    const es = new EventSource(
      `/api/admin/update/logs?container=${encodeURIComponent(containerName)}`,
    );
    const appendLine = (raw: string) => {
      const line = stripAnsi(raw);
      setLogLines((prev) => {
        const next = [...prev, line];
        return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
      });
    };
    es.addEventListener("log", (e) => {
      setStreamState("live");
      appendLine((e as MessageEvent<string>).data);
    });
    es.addEventListener("end", () => {
      setStreamState("ended");
      es.close();
    });
    es.onerror = () => {
      // Browsers fire `error` on normal close too; we only flag it as a
      // real error if we never received any data. Once we've been live
      // and then the connection drops (e.g., during server recreate),
      // we treat it as an "ended" state and rely on phase detection.
      setStreamState((prev) => (prev === "live" ? "ended" : "error"));
    };
    return () => { es.close(); };
  }, [containerName, isTerminal]);

  // Auto-scroll to bottom whenever new lines land, but only while the
  // user hasn't scrolled up manually. Detect that via `scrollHeight ≈
  // scrollTop + clientHeight` on the parent.
  useEffect(() => {
    const el = logEndRef.current;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    const nearBottom =
      parent.scrollHeight - parent.scrollTop - parent.clientHeight < 40;
    if (nearBottom) el.scrollIntoView({ block: "end" });
  }, [logLines]);

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

        {containerName && (logLines.length > 0 || streamState === "connecting") && (
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
