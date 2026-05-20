import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

interface UseTerminalOptions {
  sessionId: string;
}

export function useTerminal(options: UseTerminalOptions) {
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const mountedRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const userClosedRef = useRef(false);

  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || mountedRef.current) return;
      mountedRef.current = true;

      const term = new Terminal({
        theme: {
          background: "#1a1a2e",
          foreground: "#e0e0e0",
          cursor: "#a78bfa",
          selectionBackground: "#7c3aed33",
        },
        fontFamily: "'Courier New', 'Lucida Console', monospace",
        fontSize: 14,
        lineHeight: 1.0,
        letterSpacing: 0,
        cursorBlink: true,
        scrollback: 10_000,
        allowProposedApi: true,
      });

      const fit = new FitAddon();
      const links = new WebLinksAddon();
      term.loadAddon(fit);
      term.loadAddon(links);
      term.open(el);

      termRef.current = term;
      fitRef.current = fit;

      // Fit multiple times as layout settles
      fit.fit();
      requestAnimationFrame(() => fit.fit());
      setTimeout(() => fit.fit(), 200);
      setTimeout(() => fit.fit(), 500);

      const connect = (): void => {
        if (userClosedRef.current) return;

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${protocol}//${window.location.host}/ws/sessions/${options.sessionId}/terminal`;
        const ws = new WebSocket(wsUrl);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;

        ws.addEventListener("open", () => {
          reconnectAttemptRef.current = 0;
          fit.fit();
          term.focus();
        });

        // initialResizeSent is scoped per connection so the resize-jiggle
        // fires again after each reconnect.
        let initialResizeSent = false;
        ws.addEventListener("message", (event) => {
          // Proxy strips ttyd type bytes — we receive raw terminal output
          if (event.data instanceof ArrayBuffer) {
            term.write(new Uint8Array(event.data));
          } else {
            term.write(event.data as string);
          }

          // Send terminal dimensions after first message proves the
          // full path (ttyd → proxy → browser) is live. Sending on WS
          // open is too early — proxy→ttyd may not be connected yet.
          if (!initialResizeSent) {
            initialResizeSent = true;

            const sendResize = (cols: number, rows: number): void => {
              if (ws.readyState !== WebSocket.OPEN) return;
              const payload = JSON.stringify({ columns: cols, rows });
              const buf = new Uint8Array(payload.length + 1);
              buf[0] = 0x31; // ASCII '1' = resize
              for (let i = 0; i < payload.length; i++) {
                buf[i + 1] = payload.charCodeAt(i);
              }
              ws.send(buf.buffer);
            };

            // Bounce resize after a delay to force SIGWINCH on dtach
            // reattach. The two resizes must be in separate event-loop
            // ticks so ttyd treats them as distinct PTY size changes —
            // otherwise the kernel coalesces them and no SIGWINCH fires.
            setTimeout(() => {
              fit.fit();
              sendResize(Math.max(term.cols - 1, 1), term.rows);
              setTimeout(() => {
                sendResize(term.cols, term.rows);
              }, 100);
            }, 150);
          }
        });

        ws.addEventListener("close", () => {
          if (userClosedRef.current) {
            term.write("\r\n\x1b[33m[disconnected]\x1b[0m\r\n");
            return;
          }
          const attempt = reconnectAttemptRef.current;
          const delay = Math.min(Math.pow(2, attempt) * 1000, 30000);
          term.write(`\r\n\x1b[33m[reconnecting in ${delay / 1000}s...]\x1b[0m\r\n`);
          reconnectAttemptRef.current = attempt + 1;
          reconnectTimerRef.current = window.setTimeout(connect, delay);
        });
      };

      // Terminal input → ttyd (type bytes are ASCII: '0'=input, '1'=resize).
      // Handlers registered once; read wsRef.current so they work after reconnect.
      term.onData((data) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          const buf = new Uint8Array(data.length + 1);
          buf[0] = 0x30; // ASCII '0' = input
          for (let i = 0; i < data.length; i++) {
            buf[i + 1] = data.charCodeAt(i);
          }
          ws.send(buf.buffer);
        }
      });

      // Resize → ttyd
      term.onResize(({ cols, rows }) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          const payload = JSON.stringify({ columns: cols, rows });
          const buf = new Uint8Array(payload.length + 1);
          buf[0] = 0x31; // ASCII '1' = resize
          for (let i = 0; i < payload.length; i++) {
            buf[i + 1] = payload.charCodeAt(i);
          }
          ws.send(buf.buffer);
        }
      });

      // Type a string into the PTY (ttyd input frame: ASCII '0' prefix).
      const sendInput = (text: string): void => {
        const ws = wsRef.current;
        if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
        const buf = new Uint8Array(text.length + 1);
        buf[0] = 0x30; // ASCII '0' = input
        for (let i = 0; i < text.length; i++) buf[i + 1] = text.charCodeAt(i);
        ws.send(buf.buffer);
      };

      // Image paste: upload the bytes to the workspace and type the saved
      // path so the agent (Claude Code etc.) can read it as a file.
      const uploadImage = (blob: Blob): void => {
        const ext = (blob.type.split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "") || "png";
        const name = `paste-${Date.now()}.${ext}`;
        term.write(`\r\n\x1b[36m[uploading image...]\x1b[0m`);
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(",")[1];
          if (!base64) {
            term.write(`\r\n\x1b[31m[upload failed]\x1b[0m\r\n`);
            return;
          }
          fetch(`/api/sessions/${options.sessionId}/upload`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ name, data: base64 }),
          })
            .then((res) => {
              if (res.ok) {
                const path = `/tmp/uploads/${name}`;
                term.write(`\r\n\x1b[32m[saved: ${path}]\x1b[0m\r\n`);
                sendInput(path);
              } else {
                term.write(`\r\n\x1b[31m[upload failed]\x1b[0m\r\n`);
              }
            })
            .catch(() => {
              term.write(`\r\n\x1b[31m[upload failed]\x1b[0m\r\n`);
            });
        };
        reader.readAsDataURL(blob);
      };

      // Listen for the `paste` DOM event rather than the async Clipboard API
      // (navigator.clipboard.read). The async API only works in a secure
      // context (HTTPS / localhost), so it silently failed on plain-HTTP
      // lan-mode installs. The paste event's clipboardData is available on
      // HTTP too. Capture phase so we see the image before xterm's textarea
      // handler; plain-text paste is left to xterm's built-in handler (which
      // also reads clipboardData and works on HTTP).
      const handlePaste = (e: ClipboardEvent): void => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item && item.kind === "file" && item.type.startsWith("image/")) {
            const blob = item.getAsFile();
            if (blob) {
              e.preventDefault();
              uploadImage(blob);
              return;
            }
          }
        }
        // No image — fall through to xterm's native text paste.
      };
      el.addEventListener("paste", handlePaste, true);

      const observer = new ResizeObserver(() => {
        requestAnimationFrame(() => {
          try { fit.fit(); } catch { /* */ }
        });
      });
      observer.observe(el);

      // Force redraw when tab regains focus — clears TUI artifacts
      // from apps like Claude Code that use the alternate screen buffer
      const handleVisibility = (): void => {
        if (document.visibilityState !== "visible") return;
        requestAnimationFrame(() => {
          try {
            fit.fit();
            // Send a resize to ttyd to trigger a full screen redraw
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
              const payload = JSON.stringify({ columns: term.cols, rows: term.rows });
              const rBuf = new Uint8Array(payload.length + 1);
              rBuf[0] = 0x31;
              for (let i = 0; i < payload.length; i++) {
                rBuf[i + 1] = payload.charCodeAt(i);
              }
              ws.send(rBuf.buffer);
            }
          } catch { /* */ }
        });
      };
      document.addEventListener("visibilitychange", handleVisibility);

      cleanupRef.current = () => {
        observer.disconnect();
        document.removeEventListener("visibilitychange", handleVisibility);
        el.removeEventListener("paste", handlePaste, true);
      };

      connect();
    },
    [options.sessionId],
  );

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      cleanupRef.current?.();
      // Mark user-closed BEFORE closing WS so the close handler
      // short-circuits the reconnect loop rather than scheduling another.
      userClosedRef.current = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      wsRef.current?.close();
      termRef.current?.dispose();
      wsRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      cleanupRef.current = null;
    };
  }, [options.sessionId]);

  return { attach };
}
