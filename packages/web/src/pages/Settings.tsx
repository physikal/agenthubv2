import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { useAuthStore } from "../stores/auth.ts";
import {
  PHASE_RANK,
  UpdateProgressModal,
  type UpdatePhase,
} from "../components/UpdateProgressModal.tsx";

interface VersionInfo {
  current: { sha: string; date: string; subject: string };
  latest: { sha: string };
  behind: number;
  pending: { sha: string; subject: string }[];
  // ISO timestamp captured at server-process boot. Bumping this (vs the
  // value cached when the user clicked Update) is how the UI knows the
  // new image has actually come up — the SHA alone flips way earlier,
  // right after `git reset --hard`, well before the rebuild + recreate
  // lands.
  serverStartedAt?: string;
  // Non-fatal warning from the version endpoint — populated when we
  // succeeded enough to report the current SHA but couldn't resolve
  // origin/main to compare against (narrow-clone refspec, offline host,
  // etc). UI should surface this so users don't get a silent "Up to date"
  // that might be wrong.
  versionCheckError?: string;
}

export function Settings() {
  const { user } = useAuthStore();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setMessage({ text: "Passwords don't match", error: true });
      return;
    }
    if (newPassword.length < 4) {
      setMessage({ text: "Password must be at least 4 characters", error: true });
      return;
    }

    setSaving(true);
    setMessage(null);

    try {
      const res = await api("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      if (res.ok) {
        setMessage({ text: "Password changed", error: false });
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
      } else {
        const body = (await res.json()) as { error?: string };
        setMessage({ text: body.error ?? "Failed to change password", error: true });
      }
    } catch {
      setMessage({ text: "Failed to change password", error: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <h2 className="text-2xl font-semibold mb-6">Settings</h2>

      <div className="max-w-md space-y-8">
        <section>
          <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">
            Account
          </h3>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-zinc-500">Username</span>
              <span className="text-zinc-200">{user?.username}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zinc-500">Display Name</span>
              <span className="text-zinc-200">{user?.displayName}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zinc-500">Role</span>
              <span className="text-zinc-200">{user?.role === "admin" ? "Admin" : "User"}</span>
            </div>
          </div>
        </section>

        <section>
          <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">
            Change Password
          </h3>
          <form
            onSubmit={(e) => void handleChangePassword(e)}
            className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3"
          >
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Current password</label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">New password</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Confirm new password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none"
              />
            </div>

            {message && (
              <p className={`text-sm ${message.error ? "text-red-400" : "text-green-400"}`}>
                {message.text}
              </p>
            )}

            <button
              type="submit"
              disabled={saving || !currentPassword || !newPassword || !confirmPassword}
              className="w-full py-2 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? "Saving..." : "Change password"}
            </button>
          </form>
        </section>

        {user?.role === "admin" && <VersionPanel />}
      </div>
    </div>
  );
}

// Shared shape across all update phases. Split into a DU below so the
// compiler enforces "errorMessage is set ⇔ phase === 'failed'".
interface UpdateProgressBase {
  readonly baseline: { sha: string; serverStartedAt: string | undefined };
  readonly targetSha: string;
  readonly startedAt: number; // Date.now() when update began
  readonly modalOpen: boolean; // user may "Hide" while update keeps running
  // Name of the updater container spawned by POST /api/admin/update.
  // Used as the key for the SSE log stream and nothing else.
  readonly containerName?: string;
}
type UpdateProgress =
  | (UpdateProgressBase & { readonly phase: "pulling" | "building" | "restarting" })
  | (UpdateProgressBase & { readonly phase: "done" })
  | (UpdateProgressBase & { readonly phase: "failed"; readonly errorMessage: string });

// 20 min safety timeout. Cold double-rebuild (server + workspace images
// from scratch on a VM with no Docker layer cache) can run 8-15 min on
// its own; 20 gives operators room without falsely reporting a stall.
const UPDATE_TIMEOUT_MS = 20 * 60 * 1000;

// Live log buffer cap. Keeps the DOM tree bounded during a long build
// — the stream keeps flowing server-side, we just ring-buffer client-
// side.
const MAX_LOG_LINES = 200;

function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

type StreamState = "idle" | "connecting" | "live" | "ended" | "error";

function VersionPanel() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [opMessage, setOpMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  // Mirror of `progress` readable from inside the polling interval
  // without making `progress` a dependency of the polling effect (which
  // would clobber the interval + 20-min timeout on every phase
  // transition). Assigned via useEffect rather than inline-in-render
  // to keep React strict-mode happy.
  const progressRef = useRef<UpdateProgress | null>(null);
  useEffect(() => { progressRef.current = progress; }, [progress]);
  // Log stream state lives here (not inside the modal) so clicking Hide
  // doesn't kill the EventSource — the modal is a pure render surface.
  const [logLines, setLogLines] = useState<readonly string[]>([]);
  const [streamState, setStreamState] = useState<StreamState>("idle");

  const fetchVersion = useCallback(async (): Promise<VersionInfo | null> => {
    try {
      const res = await api("/api/admin/version");
      if (res.ok) {
        const body = (await res.json()) as VersionInfo;
        setInfo(body);
        setLoadError(null);
        return body;
      }
      const body = (await res.json()) as { error?: string };
      setLoadError(body.error ?? `HTTP ${String(res.status)}`);
      return null;
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Version check failed");
      return null;
    }
  }, []);

  useEffect(() => { void fetchVersion(); }, [fetchVersion]);

  // Monotonic phase reducer — rejects regressions so a transient network
  // blip can't bounce us from "restarting" back to "building". Extracted
  // so the polling effect can stay compact and so the logic is unit-
  // testable without a DOM.
  const advancePhase = useCallback((nextPhase: UpdatePhase, extra: Partial<UpdateProgress> = {}) => {
    setProgress((cur) => {
      if (!cur) return cur;
      if (PHASE_RANK[nextPhase] < PHASE_RANK[cur.phase]) return cur;
      if (nextPhase === "failed") {
        const errorMessage = (extra as { errorMessage?: string }).errorMessage ?? "Update failed";
        return { ...cur, ...extra, phase: "failed", errorMessage };
      }
      if (nextPhase === "done") return { ...cur, ...extra, phase: "done" };
      return { ...cur, ...extra, phase: nextPhase };
    });
  }, []);

  // Single polling effect for the lifetime of an update. Poll every 2s and
  // map the outcome onto a monotonic phase machine:
  //
  //   pulling    → building   SHA moved (git reset --hard committed)
  //   building   → restarting fetch failed (compose recreate killed the server)
  //   restarting → done       fetch succeeded with new serverStartedAt
  //
  // Forgiving done: once phase has reached "restarting" (implies we've
  // actually observed the server go down), a fresh serverStartedAt is
  // enough — the SHA check becomes redundant because a baseline with a
  // stale cached SHA would stall the strict check forever.
  useEffect(() => {
    if (!progress) return;

    const interval = setInterval(() => {
      void (async () => {
        const snap = progressRef.current;
        if (!snap) return;
        if (snap.phase === "done" || snap.phase === "failed") return;

        try {
          const res = await api("/api/admin/version");
          if (!res.ok) return;
          const next = (await res.json()) as VersionInfo;
          const shaMoved = next.current.sha !== snap.baseline.sha;
          const restarted =
            !!next.serverStartedAt &&
            next.serverStartedAt !== snap.baseline.serverStartedAt;
          if (shaMoved && restarted) {
            setInfo(next);
            advancePhase("done");
            return;
          }
          if (snap.phase === "restarting" && restarted) {
            setInfo(next);
            advancePhase("done");
            return;
          }
          if (shaMoved && snap.phase === "pulling") {
            advancePhase("building");
          }
        } catch {
          // Fetch failed — server is most likely mid-recreate. Only flip
          // to "restarting" once we've seen "building" (implies SHA
          // moved): earlier failures are more plausibly transient.
          if (snap.phase === "building") {
            advancePhase("restarting");
          }
        }
      })();
    }, 2_000);

    // Anchor the timeout to startedAt so tab-close-and-reopen doesn't
    // extend the deadline. If the remaining window is already negative
    // (user reopened a tab where the update ran long), fire immediately.
    const remaining = Math.max(0, progress.startedAt + UPDATE_TIMEOUT_MS - Date.now());
    const timeout = setTimeout(() => {
      advancePhase("failed", {
        errorMessage:
          "Update didn't finish within 20 minutes. Check `agenthub logs` or `docker logs $(docker ps -a --filter name=agenthub-updater --format '{{.Names}}' | head -1)` on the host to see where it stalled.",
      });
    }, remaining);

    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [progress?.startedAt, advancePhase]);

  // Live log stream. Scoped to containerName so the connection is
  // established once per update and torn down on cleanup. `aborted`
  // flag guards against a race where the browser fires `onerror`
  // microtask-later, after cleanup — without the flag, stale state
  // sets leak onto the next update.
  useEffect(() => {
    const container = progress?.containerName;
    if (!container) return;
    if (progress?.phase === "done" || progress?.phase === "failed") return;

    setStreamState("connecting");
    let aborted = false;
    const es = new EventSource(
      `/api/admin/update/logs?container=${encodeURIComponent(container)}`,
    );
    es.addEventListener("log", (e) => {
      if (aborted) return;
      setStreamState("live");
      const line = stripAnsi((e as MessageEvent<string>).data);
      setLogLines((prev) => {
        const next = [...prev, line];
        return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
      });
    });
    es.addEventListener("end", () => {
      if (aborted) return;
      setStreamState("ended");
      es.close();
    });
    es.onerror = () => {
      if (aborted) return;
      // Normal close also fires `error` — only treat it as a real
      // error if we never got a line through. Close explicitly so
      // EventSource doesn't auto-reconnect to a vanished container.
      setStreamState((prev) => (prev === "live" ? "ended" : "error"));
      es.close();
    };
    return () => { aborted = true; es.close(); };
  }, [progress?.containerName, progress?.phase]);

  const handleCheck = async () => {
    setChecking(true);
    setOpMessage(null);
    const next = await fetchVersion();
    setChecking(false);
    if (!next) return;
    if (next.behind === 0) {
      setOpMessage({ text: "You're on the latest version.", error: false });
    } else {
      setOpMessage({
        text: `${String(next.behind)} update${next.behind === 1 ? "" : "s"} available.`,
        error: false,
      });
    }
  };

  const handleUpdate = async () => {
    if (!info) return;
    setOpMessage(null);
    setLogLines([]); // Clear any lingering buffer from a prior run.
    setStreamState("idle");
    setProgress({
      phase: "pulling",
      baseline: { sha: info.current.sha, serverStartedAt: info.serverStartedAt },
      targetSha: info.latest.sha,
      startedAt: Date.now(),
      modalOpen: true,
    });
    try {
      const res = await api("/api/admin/update", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        advancePhase("failed", {
          errorMessage: body.error ?? `HTTP ${String(res.status)}`,
        });
      } else {
        const body = (await res.json()) as { containerName?: string };
        const cn = body.containerName;
        if (cn) {
          setProgress((cur) => (cur ? { ...cur, containerName: cn } : cur));
        }
      }
    } catch (e) {
      advancePhase("failed", {
        errorMessage: e instanceof Error ? e.message : "Update failed",
      });
    }
  };

  const handleHide = () => {
    setProgress((cur) => (cur ? { ...cur, modalOpen: false } : cur));
  };

  const handleReload = () => {
    // Append a cache-buster so any intermediate cache (browser, proxy)
    // can't hand back the stale index.html that still references the old
    // asset hashes. The server's serveStatic does revalidate via
    // Last-Modified on a refresh, but proxies can be cranky — the query
    // param guarantees a fresh request.
    const url = new URL(window.location.href);
    url.searchParams.set("_r", String(Date.now()));
    window.location.href = url.toString();
  };

  const updating = progress !== null && progress.phase !== "done" && progress.phase !== "failed";

  if (loadError) {
    return (
      <section>
        <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">Version</h3>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <p className="text-sm text-red-400">{loadError}</p>
          <p className="text-xs text-zinc-600 mt-2">
            Version check needs the git checkout mounted at /repo. If this is a fresh install, the compose should have handled that — try <code>agenthub update</code> from the host shell.
          </p>
        </div>
      </section>
    );
  }

  if (!info) {
    return (
      <section>
        <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">Version</h3>
        <p className="text-sm text-zinc-500">Loading...</p>
      </section>
    );
  }

  const isUpToDate = info.behind === 0;
  const dateLabel = new Date(info.current.date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const showResumeBanner = progress !== null && !progress.modalOpen;
  const resumeModal = () =>
    setProgress((cur) => (cur ? { ...cur, modalOpen: true } : cur));

  return (
    <>
      <section>
        <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">Version</h3>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isUpToDate ? "bg-green-400" : "bg-yellow-400"}`} />
            <span className="text-sm text-zinc-300">
              {isUpToDate ? "Up to date" : `${String(info.behind)} update${info.behind === 1 ? "" : "s"} available`}
            </span>
          </div>

          <div className="text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-zinc-500">Installed</span>
              <code className="text-zinc-200">{info.current.sha}</code>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Date</span>
              <span className="text-zinc-200">{dateLabel}</span>
            </div>
            {!isUpToDate && (
              <div className="flex justify-between">
                <span className="text-zinc-500">Latest</span>
                <code className="text-zinc-200">{info.latest.sha}</code>
              </div>
            )}
          </div>

          {info.versionCheckError && (
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2">
              <p className="text-xs text-yellow-400">
                Update check warning: {info.versionCheckError}
              </p>
            </div>
          )}

          {!isUpToDate && info.pending.length > 0 && (
            <div className="border-t border-zinc-800 pt-3">
              <p className="text-xs text-zinc-500 mb-2">Pending commits</p>
              <ul className="space-y-1">
                {info.pending.map((c) => (
                  <li key={c.sha} className="text-xs flex gap-2">
                    <code className="text-zinc-500 shrink-0">{c.sha}</code>
                    <span className="text-zinc-300 truncate">{c.subject}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              onClick={() => void handleCheck()}
              disabled={updating || checking}
              className="px-3 py-1.5 text-xs text-zinc-300 border border-zinc-700 rounded-lg hover:bg-zinc-800 disabled:opacity-40 transition-colors"
            >
              {checking ? "Checking..." : "Check for updates"}
            </button>
            {!isUpToDate && (
              <button
                onClick={() => void handleUpdate()}
                disabled={updating}
                className="px-3 py-1.5 text-xs font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-50 transition-colors"
              >
                {updating ? "Updating..." : "Update now"}
              </button>
            )}
          </div>

          {showResumeBanner && progress && (
            <button
              onClick={resumeModal}
              className="w-full text-left text-xs bg-purple-500/10 border border-purple-500/30 rounded-lg px-3 py-2 hover:bg-purple-500/20 transition-colors"
            >
              <span className="text-purple-300">
                {progress.phase === "done"
                  ? "Update finished — click to reload."
                  : progress.phase === "failed"
                    ? "Update failed — click to see details."
                    : "Update running in background — click to watch."}
              </span>
            </button>
          )}

          {opMessage && (
            <p className={`text-xs ${opMessage.error ? "text-red-400" : "text-green-400"}`}>
              {opMessage.text}
            </p>
          )}
        </div>
      </section>

      {progress && progress.modalOpen && (
        <UpdateProgressModal
          phase={progress.phase}
          fromSha={progress.baseline.sha}
          toSha={progress.targetSha}
          startedAt={progress.startedAt}
          logLines={logLines}
          streamState={streamState}
          {...(progress.phase === "failed" && { errorMessage: progress.errorMessage })}
          onHide={handleHide}
          onReload={handleReload}
        />
      )}
    </>
  );
}
