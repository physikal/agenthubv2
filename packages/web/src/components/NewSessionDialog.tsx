import { useState } from "react";
import { useSessionStore } from "../stores/sessions.ts";

interface NewSessionDialogProps {
  open: boolean;
  onClose: () => void;
}

export function NewSessionDialog({ open, onClose }: NewSessionDialogProps) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const { createSession } = useSessionStore();

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setCreating(true);
    setError("");

    try {
      await createSession({ name: name.trim() });
      setName("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create session");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md bg-zinc-900 border border-zinc-700 rounded-2xl p-6">
        <h2 className="text-lg font-semibold mb-4">New session</h2>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">
              Session name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="auth-refactor"
              autoFocus
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-purple-500 focus:outline-none"
            />
            <p className="text-xs text-zinc-500 mt-1.5">
              You'll get a bash terminal. Claude Code is pre-installed — launch it whenever you're ready.
            </p>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating || !name.trim()}
              className="px-5 py-2 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {creating ? "Creating..." : "Create session"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
