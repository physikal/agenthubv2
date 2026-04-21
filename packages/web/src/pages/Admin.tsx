import { useEffect, useState, useCallback } from "react";
import { api } from "../lib/api.ts";

interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
  createdAt: string;
}

export function Admin() {
  const [users, setUsers] = useState<AdminUser[]>([]);
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

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

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
