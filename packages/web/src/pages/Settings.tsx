import { useState } from "react";
import { api } from "../lib/api.ts";
import { useAuthStore } from "../stores/auth.ts";

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
      </div>
    </div>
  );
}
