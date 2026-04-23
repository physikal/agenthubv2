import { useEffect, useState, useCallback } from "react";
import { api } from "../lib/api.ts";

interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
  createdAt: string;
}

interface GithubAppStatus {
  registered: boolean;
  appId?: number;
  slug?: string;
  name?: string;
  htmlUrl?: string;
}

export function Admin() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [ghApp, setGhApp] = useState<GithubAppStatus | null>(null);
  const [ghAppBanner, setGhAppBanner] = useState<
    | { kind: "success"; text: string }
    | { kind: "error"; text: string }
    | null
  >(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRole, setNewRole] = useState("user");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const fetchUsers = useCallback(async () => {
    try {
      const res = await api("/api/admin/users");
      if (res.ok) {
        setUsers((await res.json()) as AdminUser[]);
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchGhAppStatus = useCallback(async () => {
    try {
      const res = await api("/api/admin/github-app/status");
      if (res.ok) setGhApp((await res.json()) as GithubAppStatus);
    } catch {
      // ignore — surfaces as "loading" in UI
    }
  }, []);

  useEffect(() => {
    void fetchUsers();
    void fetchGhAppStatus();

    // Reflect manifest-callback redirects back from GitHub as a banner
    // (?githubAppRegistered=1 on success, ?githubAppError=<reason> on
    // failure). Strip the params from the URL once we've read them so a
    // browser reload doesn't re-surface the banner.
    const url = new URL(window.location.href);
    const registered = url.searchParams.get("githubAppRegistered");
    const errReason = url.searchParams.get("githubAppError");
    if (registered === "1") {
      setGhAppBanner({ kind: "success", text: "GitHub App registered." });
      url.searchParams.delete("githubAppRegistered");
      window.history.replaceState({}, "", url.toString());
    } else if (errReason) {
      setGhAppBanner({
        kind: "error",
        text: `GitHub App registration failed: ${errReason}`,
      });
      url.searchParams.delete("githubAppError");
      window.history.replaceState({}, "", url.toString());
    }
  }, [fetchUsers, fetchGhAppStatus]);

  const handleRegisterGhApp = () => {
    // Full-page navigation — the endpoint returns HTML that auto-POSTs to
    // github.com. Using window.location keeps the admin's session cookie
    // in the request so the redirect_url callback authenticates.
    window.location.href = "/api/admin/github-app/register";
  };

  const handleUnregisterGhApp = async () => {
    if (
      !confirm(
        "Unregister the GitHub App from AgentHub? The App will remain on GitHub's side — you must delete it at github.com/settings/apps/<slug> to fully tear down.",
      )
    )
      return;
    try {
      const res = await api("/api/admin/github-app", { method: "DELETE" });
      if (res.ok) {
        setGhApp({ registered: false });
        setGhAppBanner({ kind: "success", text: "GitHub App unregistered locally." });
      } else {
        const body = (await res.json()) as { error?: string };
        setGhAppBanner({
          kind: "error",
          text: body.error ?? "Failed to unregister",
        });
      }
    } catch {
      setGhAppBanner({ kind: "error", text: "Failed to unregister" });
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername.trim() || !newPassword.trim()) return;

    setCreating(true);
    setError("");

    try {
      const res = await api("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: newUsername.trim(),
          password: newPassword,
          displayName: newDisplayName.trim() || newUsername.trim(),
          role: newRole,
        }),
      });

      if (res.ok) {
        setShowCreate(false);
        setNewUsername("");
        setNewPassword("");
        setNewDisplayName("");
        setNewRole("user");
        void fetchUsers();
      } else {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? "Failed to create user");
      }
    } catch {
      setError("Failed to create user");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string, username: string) => {
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;

    try {
      await api(`/api/admin/users/${id}`, { method: "DELETE" });
      void fetchUsers();
    } catch {
      // ignore
    }
  };

  const handleResetPassword = async (id: string, username: string) => {
    const newPw = prompt(`Enter new password for "${username}":`);
    if (!newPw?.trim()) return;

    try {
      const res = await api(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPw }),
      });
      if (res.ok) {
        alert("Password reset");
      } else {
        const body = (await res.json()) as { error?: string };
        alert(body.error ?? "Failed to reset password");
      }
    } catch {
      alert("Failed to reset password");
    }
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-semibold">Users</h2>
        <button
          onClick={() => setShowCreate(true)}
          className="px-5 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm font-medium hover:bg-zinc-700 transition-colors"
        >
          + Create user
        </button>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800">
              <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Username</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Display Name</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Role</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-zinc-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-zinc-800/50 last:border-0">
                <td className="px-4 py-3 text-zinc-200">{u.username}</td>
                <td className="px-4 py-3 text-zinc-400">{u.displayName}</td>
                <td className="px-4 py-3">
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      u.role === "admin"
                        ? "bg-purple-500/10 text-purple-400"
                        : "bg-zinc-800 text-zinc-400"
                    }`}
                  >
                    {u.role}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => void handleResetPassword(u.id, u.username)}
                      className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      Reset password
                    </button>
                    <button
                      onClick={() => void handleDelete(u.id, u.username)}
                      className="text-xs text-red-500 hover:text-red-400 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-10">
        <h2 className="text-2xl font-semibold mb-4">GitHub App</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          {ghAppBanner && (
            <div
              className={`mb-4 px-3 py-2 rounded text-sm ${
                ghAppBanner.kind === "success"
                  ? "bg-green-500/10 text-green-400 border border-green-500/30"
                  : "bg-red-500/10 text-red-400 border border-red-500/30"
              }`}
            >
              {ghAppBanner.text}
            </div>
          )}
          {ghApp === null ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : ghApp.registered ? (
            <>
              <p className="text-sm text-zinc-300 mb-1">
                Registered as <span className="font-mono text-purple-300">{ghApp.name}</span>{" "}
                (App ID {ghApp.appId})
              </p>
              <p className="text-xs text-zinc-500 mb-4">
                <a
                  href={ghApp.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-zinc-300 underline"
                >
                  View on GitHub
                </a>
                {" · "}
                Users install the App from the Integrations page to grant repo access.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={handleRegisterGhApp}
                  className="px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm hover:bg-zinc-700 transition-colors"
                >
                  Re-register
                </button>
                <button
                  onClick={() => void handleUnregisterGhApp()}
                  className="px-4 py-2 text-sm text-red-400 hover:text-red-300 transition-colors"
                >
                  Unregister
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-zinc-300 mb-2">
                Register this AgentHub install as a GitHub App so users can authorize repos
                without per-user Personal Access Tokens.
              </p>
              <p className="text-xs text-zinc-500 mb-4">
                You'll be redirected to GitHub to approve the App manifest. The redirect
                target and webhook URL must be publicly reachable — localhost installs
                should tunnel or use a real domain.
              </p>
              <button
                onClick={handleRegisterGhApp}
                className="px-5 py-2.5 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-500 transition-colors"
              >
                Register GitHub App
              </button>
            </>
          )}
        </div>
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-zinc-900 border border-zinc-700 rounded-2xl p-6">
            <h3 className="text-lg font-semibold mb-4">Create user</h3>
            <form onSubmit={(e) => void handleCreate(e)} className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Username</label>
                <input
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  autoFocus
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Display name (optional)</label>
                <input
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Role</label>
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none"
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>

              {error && <p className="text-sm text-red-400">{error}</p>}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => { setShowCreate(false); setError(""); }}
                  className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating || !newUsername.trim() || !newPassword.trim()}
                  className="px-5 py-2 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {creating ? "Creating..." : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
