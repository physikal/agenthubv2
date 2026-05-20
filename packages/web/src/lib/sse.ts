import { api } from "./api.ts";

export interface SSERunHandlers {
  onLog?: (line: string) => void;
  onDone?: (data: string) => void;
  onError?: (data: string) => void;
}

/**
 * POST `path` with `body` and consume an `event: log|done|error` SSE stream.
 * Resolves when the stream ends. Network/non-OK failures call onError.
 */
export async function streamRun(
  path: string,
  body: unknown,
  handlers: SSERunHandlers,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  let res: Response;
  try {
    res = await api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    handlers.onError?.(err instanceof Error ? err.message : "request failed");
    return;
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    handlers.onError?.(text || `HTTP ${res.status}`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const lines = part.split("\n");
      const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
      const data = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (event === "log") handlers.onLog?.(data);
      else if (event === "done") handlers.onDone?.(data);
      else if (event === "error") handlers.onError?.(data);
    }
  }
}
