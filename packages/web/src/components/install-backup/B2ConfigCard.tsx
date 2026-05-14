import { useState, useEffect, useCallback } from "react";
import { api } from "../../lib/api.js";

interface B2Config {
  keyId: string;
  appKey: string;
  bucket: string;
  pathPrefix: string;
  retentionKeepLast: number;
}

export function B2ConfigCard() {
  const [keyId, setKeyId] = useState("");
  const [appKey, setAppKey] = useState("");
  const [bucket, setBucket] = useState("");
  const [pathPrefix, setPathPrefix] = useState("installs/");
  const [retentionKeepLast, setRetentionKeepLast] = useState(10);
  const [status, setStatus] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api("/api/admin/install-backup");
      if (r.ok) {
        const j = (await r.json()) as { b2?: B2Config };
        if (j.b2) {
          setKeyId(j.b2.keyId);
          setAppKey(j.b2.appKey);
          setBucket(j.b2.bucket);
          setPathPrefix(j.b2.pathPrefix);
          setRetentionKeepLast(j.b2.retentionKeepLast);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    setSaving(true);
    setStatus("");
    try {
      const body: Record<string, unknown> = {
        b2KeyId: keyId,
        b2Bucket: bucket,
        b2PathPrefix: pathPrefix,
        retentionKeepLast,
      };
      if (appKey && appKey !== "••••••••") body["b2AppKey"] = appKey;

      const r = await api("/api/admin/install-backup", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        setStatus("Saved.");
        void load();
      } else {
        setStatus(`Save failed: ${r.status}`);
      }
    } catch (err) {
      setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setStatus("Testing...");
    try {
      const r = await api("/api/admin/install-backup/test", { method: "POST" });
      const j = (await r.json()) as { ok: boolean; fileCount?: number; error?: string };
      if (j.ok) setStatus(`OK — ${j.fileCount ?? 0} object(s) in bucket.`);
      else setStatus(`Failed: ${j.error ?? "unknown error"}`);
    } catch (err) {
      setStatus(`Test failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
      <h3 className="text-sm font-semibold text-zinc-200">B2 destination</h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Key ID</label>
          <input
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm
              focus:border-purple-500 focus:outline-none text-zinc-200"
            value={keyId}
            onChange={(e) => setKeyId(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">App Key</label>
          <input
            type="password"
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm
              focus:border-purple-500 focus:outline-none text-zinc-200"
            value={appKey}
            onChange={(e) => setAppKey(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Bucket</label>
          <input
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm
              focus:border-purple-500 focus:outline-none text-zinc-200"
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Path prefix</label>
          <input
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm
              focus:border-purple-500 focus:outline-none text-zinc-200"
            value={pathPrefix}
            onChange={(e) => setPathPrefix(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Keep last N backups</label>
          <input
            type="number"
            min={1}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm
              focus:border-purple-500 focus:outline-none text-zinc-200"
            value={retentionKeepLast}
            onChange={(e) => setRetentionKeepLast(parseInt(e.target.value, 10) || 10)}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium
            hover:bg-purple-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? "Saving..." : "Save"}
        </button>
        <button
          className="px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm
            hover:bg-zinc-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={testing}
          onClick={() => void test()}
        >
          {testing ? "Testing..." : "Test connection"}
        </button>
        {status && <span className="text-sm text-zinc-400">{status}</span>}
      </div>
    </div>
  );
}
