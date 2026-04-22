import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { useAuthStore } from "../stores/auth.ts";

interface VersionInfo {
  current: { sha: string; date: string; subject: string };
  latest: { sha: string };
  behind: number;
  ahead: number;
  pending: { sha: string; subject: string }[];
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

function VersionPanel() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [opMessage, setOpMessage] = useState<{ text: string; error: boolean } | null>(null);

  const fetchVersion = useCallback(async () => {
    try {
      const res = await api("/api/admin/version");
      if (res.ok) {
        setInfo((await res.json()) as VersionInfo);
        setLoadError(null);
      } else {
        const body = (await res.json()) as { error?: string };
        setLoadError(body.error ?? `HTTP ${String(res.status)}`);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Version check failed");
    }
  }, []);

  useEffect(() => { void fetchVersion(); }, [fetchVersion]);

  // While an update is in flight the server is being recreated. Poll every
  // 2s; the fetch will error-out for ~5s during the recreate, then come
  // back with a (hopefully) new SHA. When the SHA changes, stop polling
  // and declare victory.
  useEffect(() => {
    if (!updating) return;
    const startSha = info?.current.sha;
    const interval = setInterval(() => {
      void (async () => {
        try {
          const res = await api("/api/admin/version");
          if (!res.ok) return;
          const next = (await res.json()) as VersionInfo;
          if (next.current.sha !== startSha) {
            setInfo(next);
            setUpdating(false);
            setOpMessage({ text: `Updated to ${next.current.sha}`, error: false });
          }
        } catch { /* expected during recreate */ }
      })();
    }, 2_000);
    // Safety: stop polling after 3 minutes regardless.
    const timeout = setTimeout(() => {
      setUpdating(false);
      setOpMessage({ text: "Update didn't complete in 3 minutes — check server logs", error: true });
    }, 180_000);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [updating, info?.current.sha]);

  const handleUpdate = async () => {
    if (!confirm("Update AgentHub? The server will restart briefly during the update.")) return;
    setUpdating(true);
    setOpMessage(null);
    try {
      const res = await api("/api/admin/update", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setOpMessage({ text: body.error ?? `HTTP ${String(res.status)}`, error: true });
        setUpdating(false);
      } else {
        setOpMessage({ text: "Update kicked off — server will restart shortly...", error: false });
      }
    } catch (e) {
      setOpMessage({ text: e instanceof Error ? e.message : "Update failed", error: true });
      setUpdating(false);
    }
  };

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

  return (
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
            onClick={() => void fetchVersion()}
            disabled={updating}
            className="px-3 py-1.5 text-xs text-zinc-300 border border-zinc-700 rounded-lg hover:bg-zinc-800 disabled:opacity-40 transition-colors"
          >
            Check for updates
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

        {opMessage && (
          <p className={`text-xs ${opMessage.error ? "text-red-400" : "text-green-400"}`}>
            {opMessage.text}
          </p>
        )}
      </div>
    </section>
  );
}
