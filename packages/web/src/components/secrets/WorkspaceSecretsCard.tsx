import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";

/**
 * UI for managing per-user "workspace secrets" — env vars AgentHub injects
 * into the workspace shell at session-active time. Backed by
 * `/api/user/workspace-env`.
 *
 * Values are write-only after submission: the API list endpoint returns
 * names only. To rotate, delete the row and create a new one with the
 * same name.
 *
 * Changes only take effect on NEW sessions — existing sessions keep
 * whatever env they started with. The card surfaces this caveat inline.
 */

const NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export function WorkspaceSecretsCard(): React.JSX.Element {
  const [names, setNames] = useState<string[] | null>(null);
  const [loadErr, setLoadErr] = useState<string>("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [submitErr, setSubmitErr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await api("/api/user/workspace-env");
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setLoadErr(body.error ?? `HTTP ${String(res.status)}`);
        setNames([]);
        return;
      }
      const body = (await res.json()) as { names: string[] };
      setNames(body.names);
      setLoadErr("");
    } catch (err) {
      setLoadErr(err instanceof Error ? err.message : "Network error");
      setNames([]);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const resetAdd = () => {
    setAdding(false);
    setNewName("");
    setNewValue("");
    setShowValue(false);
    setSubmitErr("");
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitErr("");
    if (!NAME_PATTERN.test(newName)) {
      setSubmitErr(
        "Name must be POSIX-style: uppercase letters, digits, underscores; can't start with a digit.",
      );
      return;
    }
    if (!newValue) {
      setSubmitErr("Value can't be empty.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await api("/api/user/workspace-env", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName, value: newValue }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSubmitErr(body.error ?? `HTTP ${String(res.status)}`);
        return;
      }
      resetAdd();
      await load();
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete workspace secret "${name}"? New sessions will no longer see it.`)) {
      return;
    }
    setDeleting(name);
    try {
      const res = await api(`/api/user/workspace-env/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setLoadErr(body.error ?? `Delete failed (HTTP ${String(res.status)})`);
        return;
      }
      await load();
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-zinc-200 mb-1">
        Workspace secrets
      </h3>
      <p className="text-xs text-zinc-500 mb-4">
        Per-user env vars AgentHub injects into your workspace shell at
        session start. Use for API tokens (e.g. <code className="text-zinc-300">CLOUDFLARE_API_TOKEN</code>)
        that the agent or your code inside the session needs to read.
        Changes only apply to <em>new</em> sessions.
      </p>

      {loadErr && (
        <p className="text-xs text-red-400 mb-3">Load error: {loadErr}</p>
      )}

      {names && names.length > 0 && (
        <ul className="space-y-2 mb-4">
          {names.map((name) => (
            <li
              key={name}
              className="flex items-center gap-2 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg"
            >
              <code className="flex-1 text-sm text-zinc-100 font-mono">{name}</code>
              <span className="text-xs text-zinc-600 font-mono">••••••</span>
              <button
                type="button"
                onClick={() => void handleDelete(name)}
                disabled={deleting === name}
                className="px-2 py-1 text-xs text-zinc-400 hover:text-red-300 border border-zinc-800 hover:border-red-900 rounded transition-colors disabled:opacity-50"
              >
                {deleting === name ? "Deleting…" : "Delete"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {names && names.length === 0 && !adding && (
        <p className="text-xs text-zinc-600 mb-4">No workspace secrets yet.</p>
      )}

      {!adding && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="px-3 py-1.5 text-sm font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 rounded-lg transition-colors"
        >
          Add workspace secret
        </button>
      )}

      {adding && (
        <form onSubmit={handleAdd} className="space-y-3">
          <label className="block">
            <span className="block text-xs text-zinc-400 mb-1">Env var name</span>
            <input
              type="text"
              autoFocus
              placeholder="CLOUDFLARE_API_TOKEN"
              value={newName}
              onChange={(e) => setNewName(e.target.value.toUpperCase())}
              className="w-full px-3 py-2 text-sm bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 font-mono focus:outline-none focus:border-purple-500"
            />
          </label>
          <label className="block">
            <span className="block text-xs text-zinc-400 mb-1">Value</span>
            <div className="flex items-center gap-2">
              <input
                type={showValue ? "text" : "password"}
                autoComplete="off"
                placeholder="paste the token / key / secret"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                className="flex-1 px-3 py-2 text-sm bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 font-mono focus:outline-none focus:border-purple-500"
              />
              <button
                type="button"
                onClick={() => setShowValue((v) => !v)}
                className="px-2 py-2 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-800 rounded-lg"
              >
                {showValue ? "Hide" : "Show"}
              </button>
            </div>
          </label>
          {submitErr && <p className="text-xs text-red-400">{submitErr}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={submitting || !newName || !newValue}
              className="px-3 py-1.5 text-sm font-medium bg-purple-600 hover:bg-purple-500 disabled:bg-zinc-700 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
            >
              {submitting ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={resetAdd}
              className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
