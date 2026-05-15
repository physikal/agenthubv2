import { useEffect, useState } from "react";

interface Props {
  toolId: string;
  displayName: string;
  onClose: (success: boolean) => void;
}

type Phase = "preparing" | "awaiting-url" | "awaiting-callback" | "captured" | "done" | "error";

interface Callbacks {
  setPhase: (p: Phase) => void;
  setUrl: (u: string | null) => void;
  setCode: (c: string | null) => void;
  setAcceptsCodeInput: (b: boolean) => void;
  setError: (m: string) => void;
  onDone: (ok: boolean) => void;
}

export function AgentLoginModal({ toolId, displayName, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("preparing");
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [acceptsCodeInput, setAcceptsCodeInput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState("");
  const [pasteSubmitting, setPasteSubmitting] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    void runConnect(toolId, ctrl.signal, {
      setPhase,
      setUrl,
      setCode,
      setAcceptsCodeInput,
      setError,
      onDone: (ok) => {
        if (ok) setTimeout(() => onClose(true), 1500);
      },
    });
    return () => ctrl.abort();
  }, [toolId, onClose]);

  const submitPaste = async (): Promise<void> => {
    const text = pasteValue.trim();
    if (!text) return;
    setPasteSubmitting(true);
    try {
      await fetch(`/api/integrations/agents/${toolId}/input`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      setPasteValue("");
    } finally {
      setPasteSubmitting(false);
    }
  };

  const copyCode = async (): Promise<void> => {
    if (!code) return;
    let ok = false;
    // navigator.clipboard only works in secure contexts (HTTPS / localhost).
    // Plain-HTTP LAN deploys hit a fallback.
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(code);
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      const ta = document.createElement("textarea");
      ta.value = code;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      document.body.removeChild(ta);
    }
    if (ok) {
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1500);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={() => onClose(false)}
    >
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 max-w-md w-full mx-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-zinc-100 mb-4">Connect {displayName}</h2>

        {phase === "preparing" && (
          <p className="text-sm text-zinc-400 flex items-center gap-2">
            <span className="inline-block w-3 h-3 border-2 border-zinc-500 border-t-zinc-100 rounded-full animate-spin" />
            Preparing secure auth helper…
          </p>
        )}

        {url && (phase === "awaiting-url" || phase === "awaiting-callback") && (
          <>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="block px-4 py-3 bg-blue-600 hover:bg-blue-500 text-zinc-100 text-center font-medium rounded-lg transition-colors"
            >
              Open {displayName} login →
            </a>

            {code && (
              <div className="mt-4 bg-zinc-950/70 border border-zinc-700 rounded-lg px-4 py-3">
                <div className="text-xs text-zinc-500 mb-1">Enter this one-time code at the URL:</div>
                <div className="flex items-center gap-2">
                  <code className="font-mono text-lg tracking-wider text-zinc-100 select-all">
                    {code}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copyCode()}
                    className="ml-auto px-2 py-1 text-xs text-zinc-300 border border-zinc-700 rounded hover:bg-zinc-800 transition-colors"
                  >
                    {codeCopied ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>
            )}

            {acceptsCodeInput && (
              <div className="mt-4">
                <label className="text-xs text-zinc-500 block mb-1">
                  After signing in, paste the code shown on the confirmation page:
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={pasteValue}
                    onChange={(e) => setPasteValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void submitPaste(); }}
                    placeholder="paste code here"
                    className="flex-1 bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-100 font-mono focus:outline-none focus:border-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => void submitPaste()}
                    disabled={!pasteValue.trim() || pasteSubmitting}
                    className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-zinc-100 rounded-lg transition-colors"
                  >
                    Submit
                  </button>
                </div>
              </div>
            )}

            <p className="text-xs text-zinc-500 mt-4 flex items-center gap-2">
              {phase === "awaiting-callback" && (
                <span className="inline-block w-3 h-3 border-2 border-zinc-500 border-t-zinc-100 rounded-full animate-spin" />
              )}
              {phase === "awaiting-callback"
                ? "Waiting for you to complete the sign-in…"
                : "Opens in your browser. Sign in with the account you want this workspace to use."}
            </p>
          </>
        )}

        {phase === "awaiting-callback" && !url && (
          <p className="text-sm text-zinc-400 flex items-center gap-2">
            <span className="inline-block w-3 h-3 border-2 border-zinc-500 border-t-zinc-100 rounded-full animate-spin" />
            Waiting for you to complete the sign-in…
          </p>
        )}

        {phase === "captured" && (
          <p className="text-sm text-zinc-400">Credentials captured. Finalising…</p>
        )}

        {phase === "done" && (
          <p className="text-sm text-green-400">&#x2713; Connected.</p>
        )}

        {phase === "error" && (
          <p className="text-sm text-red-400">{error ?? "Something went wrong."}</p>
        )}

        <button
          type="button"
          onClick={() => onClose(false)}
          className="mt-4 px-3 py-1.5 text-xs text-zinc-300 border border-zinc-700 rounded-lg hover:bg-zinc-800 transition-colors"
        >
          {phase === "done" ? "Close" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

async function runConnect(
  toolId: string,
  signal: AbortSignal,
  cbs: Callbacks,
): Promise<void> {
  try {
    const r = await fetch(`/api/integrations/agents/${toolId}/connect`, {
      method: "POST",
      credentials: "include",
      signal,
    });
    if (!r.body) {
      cbs.setError("no stream");
      cbs.setPhase("error");
      return;
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handleEvent(chunk, cbs);
      }
    }
  } catch (err) {
    if ((err as { name?: string }).name !== "AbortError") {
      const message = err instanceof Error ? err.message : "unknown";
      cbs.setError(message);
      cbs.setPhase("error");
    }
  }
}

function handleEvent(chunk: string, cbs: Callbacks): void {
  let event = "message";
  let data = "";
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data += line.slice(6);
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    /* ignore non-JSON */
  }
  if (event === "url") {
    cbs.setUrl(String(parsed["url"]));
    if (parsed["acceptsCodeInput"] === true) cbs.setAcceptsCodeInput(true);
    cbs.setPhase("awaiting-url");
  } else if (event === "code") {
    cbs.setCode(String(parsed["code"]));
  } else if (event === "captured") {
    cbs.setPhase("captured");
  } else if (event === "done") {
    cbs.setPhase("done");
    cbs.onDone(true);
  } else if (event === "error") {
    cbs.setError(String(parsed["message"] ?? ""));
    cbs.setPhase("error");
    cbs.onDone(false);
  } else if (event === "state" && typeof parsed["phase"] === "string") {
    cbs.setPhase(parsed["phase"] as Phase);
  }
}
