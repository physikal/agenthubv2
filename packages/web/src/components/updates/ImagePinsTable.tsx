import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { ImageRowConfirmModal } from "./ImageRowConfirmModal.tsx";

type ImageKey = "traefik" | "postgres" | "redis" | "infisical";

interface ImageRow {
  readonly image: ImageKey;
  readonly displayName: string;
  readonly pinnedTag: string;
  readonly newestWithinMajor: string | null;
  readonly newestAcrossMajor: string | null;
  readonly upstreamDigest: string | null;
  readonly runningDigest: string | null;
  readonly updateAvailable: boolean;
  readonly lastCheckedAt: string | null;
  readonly lastError: string | null;
  readonly disruption: string;
}

interface PendingApply {
  readonly image: ImageKey;
  readonly tag: string | "DIGEST";
  readonly isMajor: boolean;
}

const MAX_LOG_LINES = 200;

function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export function ImagePinsTable(): JSX.Element {
  const [rows, setRows] = useState<readonly ImageRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingApply | null>(null);
  const [progressImage, setProgressImage] = useState<ImageKey | null>(null);
  const [phase, setPhase] = useState<string>("");
  const [logLines, setLogLines] = useState<readonly string[]>([]);
  const [opError, setOpError] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    try {
      const res = await api("/api/admin/updates");
      if (!res.ok) {
        const b = (await res.json()) as { error?: string };
        setLoadError(b.error ?? `HTTP ${String(res.status)}`);
        return;
      }
      const body = (await res.json()) as { images: readonly ImageRow[] };
      setRows(body.images);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "load failed");
    }
  }, []);

  useEffect(() => { void fetchRows(); }, [fetchRows]);

  const startApply = (image: ImageKey, tag: string | "DIGEST", isMajor: boolean) => {
    setOpError(null);
    setLogLines([]);
    setPhase("");
    setPending({ image, tag, isMajor });
  };

  const confirmApply = async (ack: boolean) => {
    if (!pending) return;
    const body =
      pending.tag === "DIGEST"
        ? { image: "infisical", digestUpdate: true }
        : { image: pending.image, tag: pending.tag, acknowledgedMajor: ack };
    setPending(null);
    setProgressImage(pending.image);
    const res = await fetch("/api/admin/updates/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      setOpError(b.error ?? `HTTP ${String(res.status)}`);
      setProgressImage(null);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const block of events) {
        let evt = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) evt = line.slice(6).trim();
          else if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (evt === "phase") setPhase(data);
        else if (evt === "log") {
          const line = stripAnsi(data);
          setLogLines((prev) => {
            const next = [...prev, line];
            return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
          });
        } else if (evt === "error") setOpError(data);
      }
    }
    setProgressImage(null);
    void fetchRows();
  };

  return (
    <div className="rounded-md border border-zinc-800 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-semibold">Container image pins</h3>
        <button
          type="button"
          onClick={() => void fetchRows()}
          className="text-xs text-zinc-400 hover:text-zinc-200"
        >
          Refresh
        </button>
      </div>
      {loadError && <p className="text-sm text-red-400">{loadError}</p>}
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-zinc-500">
          <tr>
            <th className="py-2">Image</th>
            <th>Pinned</th>
            <th>Within-major</th>
            <th>Major bump</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isDigestMode = r.image === "infisical";
            const digestNewer = !!(r.upstreamDigest && r.runningDigest && r.upstreamDigest !== r.runningDigest);
            return (
              <tr key={r.image} className="border-t border-zinc-800">
                <td className="py-2">{r.displayName}</td>
                <td><code className="text-zinc-300">{r.pinnedTag}</code></td>
                <td>
                  {isDigestMode
                    ? <span className="text-zinc-500">digest mode</span>
                    : r.newestWithinMajor
                      ? <span className="text-sky-300">{r.newestWithinMajor}</span>
                      : <span className="text-zinc-500">—</span>}
                </td>
                <td>
                  {r.newestAcrossMajor
                    ? <span className="text-amber-400">{r.newestAcrossMajor} ⚠</span>
                    : <span className="text-zinc-500">—</span>}
                </td>
                <td className="text-right">
                  {isDigestMode && digestNewer && (
                    <button
                      type="button"
                      onClick={() => startApply(r.image, "DIGEST", false)}
                      className="rounded-md bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-500"
                    >
                      Pull new digest
                    </button>
                  )}
                  {!isDigestMode && r.newestWithinMajor && (
                    <button
                      type="button"
                      onClick={() => startApply(r.image, r.newestWithinMajor!, false)}
                      className="rounded-md bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-500"
                    >
                      Update to {r.newestWithinMajor}
                    </button>
                  )}
                  {!isDigestMode && r.newestAcrossMajor && !r.newestWithinMajor && (
                    <button
                      type="button"
                      onClick={() => startApply(r.image, r.newestAcrossMajor!, true)}
                      className="rounded-md bg-amber-600 px-2.5 py-1 text-xs text-white hover:bg-amber-500"
                    >
                      Update to {r.newestAcrossMajor}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {progressImage && (
        <div className="mt-4 rounded-md bg-zinc-950 p-3 font-mono text-xs">
          <div className="mb-2 text-zinc-400">Phase: {phase}</div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap">
            {logLines.join("\n")}
          </pre>
        </div>
      )}
      {opError && <p className="mt-3 text-sm text-red-400">{opError}</p>}
      {pending && (() => {
        const row = rows.find((r) => r.image === pending.image);
        if (!row) return null;
        return (
          <ImageRowConfirmModal
            displayName={row.displayName}
            currentTag={row.pinnedTag}
            targetTag={pending.tag === "DIGEST" ? "(new digest)" : pending.tag}
            disruption={row.disruption}
            isMajor={pending.isMajor}
            onConfirm={(ack) => void confirmApply(ack)}
            onCancel={() => setPending(null)}
          />
        );
      })()}
    </div>
  );
}
