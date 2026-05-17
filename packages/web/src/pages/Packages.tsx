import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";

type CatalogState =
  | "not-installed"
  | "installing"
  | "ready"
  | "removing"
  | "error";

interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  homepage?: string;
  essential: boolean;
  state: CatalogState;
  version?: string | null;
  error?: string | null;
  updatedAt?: string | null;
  latestVersion?: string | null;
  updateAvailable?: boolean;
  versionCheckedAt?: string | null;
  versionCheckError?: string | null;
}

const STATE_DOT: Record<CatalogState, string> = {
  "not-installed": "bg-zinc-700",
  installing: "bg-yellow-400",
  removing: "bg-yellow-400",
  ready: "bg-green-400",
  error: "bg-red-400",
};

const STATE_LABEL: Record<CatalogState, string> = {
  "not-installed": "Not installed",
  installing: "Installing…",
  removing: "Removing…",
  ready: "Installed",
  error: "Install failed",
};

const STATE_COLOR: Record<CatalogState, string> = {
  "not-installed": "text-zinc-500",
  installing: "text-yellow-400",
  removing: "text-yellow-400",
  ready: "text-green-400",
  error: "text-red-400",
};

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${String(m)} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)} h ago`;
  return `${String(Math.floor(h / 24))} d ago`;
}

function PackageCard({
  entry,
  onChanged,
}: {
  entry: CatalogEntry;
  onChanged: () => void;
}) {
  const [current, setCurrent] = useState(entry);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => setCurrent(entry), [entry]);

  useEffect(() => {
    if (current.state !== "installing" && current.state !== "removing") return;
    const interval = setInterval(async () => {
      try {
        const res = await api(`/api/packages/${current.id}/status`);
        if (!res.ok) return;
        const data = (await res.json()) as CatalogEntry;
        setCurrent(data);
        if (data.state !== "installing" && data.state !== "removing") {
          onChanged();
        }
      } catch { /* retry */ }
    }, 3_000);
    return () => clearInterval(interval);
  }, [current.id, current.state, onChanged]);

  const pulse = current.state === "installing" || current.state === "removing";
  const installed = current.state === "ready" || current.state === "error";
  const updateAvailable = current.updateAvailable === true && installed;
  const canInstall = current.state === "not-installed" || current.state === "error";
  const canUpdate = updateAvailable && current.state !== "installing" && current.state !== "removing";
  const canRemove = current.state === "ready" || current.state === "error";

  const handleInstall = async (verb: "install" | "update") => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api(`/api/packages/${current.id}/install`, { method: "POST" });
      if (res.ok || res.status === 202) {
        setCurrent((prev) => ({ ...prev, state: "installing", error: null }));
      } else {
        const body = (await res.json()) as { error?: string };
        setMessage({ text: body.error ?? `${verb} failed`, error: true });
      }
    } catch {
      setMessage({ text: `${verb} failed`, error: true });
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    if (!confirm(`Remove ${current.name}?`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await api(`/api/packages/${current.id}/remove`, { method: "POST" });
      if (res.ok || res.status === 202) {
        setCurrent((prev) => ({ ...prev, state: "removing" }));
      } else {
        const body = (await res.json()) as { error?: string };
        setMessage({ text: body.error ?? "Remove failed", error: true });
      }
    } catch {
      setMessage({ text: "Remove failed", error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-start justify-between mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span
              className={`w-2 h-2 rounded-full ${STATE_DOT[current.state]} ${pulse ? "animate-pulse" : ""}`}
            />
            <h3 className="font-medium text-zinc-100">{current.name}</h3>
            {current.essential && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                Essential
              </span>
            )}
            {current.version && (
              <code className="text-[10px] text-zinc-500">{current.version}</code>
            )}
            {updateAvailable && current.latestVersion && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/10 border border-yellow-500/30 text-yellow-200">
                Update available — {current.version ?? "?"} → {current.latestVersion}
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500">{current.description}</p>
          {current.homepage && (
            <a
              href={current.homepage}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-purple-400 hover:underline"
            >
              {current.homepage.replace(/^https?:\/\//, "")}
            </a>
          )}
        </div>
        <span className={`text-xs whitespace-nowrap ml-3 ${STATE_COLOR[current.state]}`}>
          {STATE_LABEL[current.state]}
        </span>
      </div>

      {current.error && current.state === "error" && (
        <p className="text-xs text-red-400 mt-1">{current.error}</p>
      )}

      <div className="flex gap-2 mt-3 flex-wrap items-center">
        {canUpdate && (
          <button
            onClick={() => void handleInstall("update")}
            disabled={busy}
            className="px-3 py-1.5 text-xs font-medium bg-yellow-500 text-zinc-900 rounded-lg hover:bg-yellow-400 disabled:opacity-50 transition-colors"
          >
            Update
          </button>
        )}
        {canInstall && !canUpdate && (
          <button
            onClick={() => void handleInstall("install")}
            disabled={busy}
            className="px-3 py-1.5 text-xs font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-50 transition-colors"
          >
            {current.state === "error" ? "Retry install" : "Install"}
          </button>
        )}
        {canRemove && (
          <button
            onClick={() => void handleRemove()}
            disabled={busy}
            className="px-3 py-1.5 text-xs text-red-400 border border-zinc-700 rounded-lg hover:bg-zinc-800 disabled:opacity-50 transition-colors"
          >
            Remove
          </button>
        )}
        {current.versionCheckedAt && (
          <span
            className="text-[10px] text-zinc-600 ml-auto"
            title={current.versionCheckError ?? `Checked ${current.versionCheckedAt}`}
          >
            {current.versionCheckError
              ? "Version check failed"
              : `Last checked ${formatRelative(current.versionCheckedAt)}`}
          </span>
        )}
      </div>

      {message && (
        <p className={`mt-2 text-xs ${message.error ? "text-red-400" : "text-green-400"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}

export function Packages() {
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchEntries = useCallback(async () => {
    try {
      const res = await api("/api/packages");
      if (res.ok) {
        setEntries((await res.json()) as CatalogEntry[]);
        setLoadError(null);
      } else {
        setLoadError("Could not load packages");
      }
    } catch {
      setLoadError("Could not load packages");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchEntries(); }, [fetchEntries]);

  if (loading) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <h2 className="text-2xl font-semibold mb-6">Packages</h2>
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <h2 className="text-2xl font-semibold mb-2">Packages</h2>
      <p className="text-sm text-zinc-500 mb-6">
        Coding-agent CLIs available in your workspace. Installs land in
        <code className="mx-1 text-zinc-400">~/.local/bin</code>
        and persist across sessions. Essentials (Claude Code, OpenCode,
        Codex) auto-install on every new session; everything else is
        opt-in. Update checks run every 30 minutes against the npm
        registry.
      </p>

      {loadError && (
        <p className="text-sm text-red-400 mb-4">{loadError}</p>
      )}

      <div className="max-w-2xl space-y-4">
        {entries.map((entry) => (
          <PackageCard
            key={entry.id}
            entry={entry}
            onChanged={() => void fetchEntries()}
          />
        ))}
      </div>
    </div>
  );
}
