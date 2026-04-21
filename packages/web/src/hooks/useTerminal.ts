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

      // Connect to ttyd via portal proxy (binary WebSocket)
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws/sessions/${options.sessionId}/terminal`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        fit.fit();
        term.focus();
      });

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
        term.write("\r\n\x1b[33m[disconnected]\x1b[0m\r\n");
      });

      // Terminal input → ttyd (type bytes are ASCII: '0'=input, '1'=resize)
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
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
        if (ws.readyState === WebSocket.OPEN) {
          const payload = JSON.stringify({ columns: cols, rows });
          const buf = new Uint8Array(payload.length + 1);
          buf[0] = 0x31; // ASCII '1' = resize
          for (let i = 0; i < payload.length; i++) {
            buf[i + 1] = payload.charCodeAt(i);
          }
          ws.send(buf.buffer);
        }
      });

      // Image paste: intercept Cmd+V, upload via separate channel
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.type === "keydown" && e.key === "v" && (e.metaKey || e.ctrlKey)) {
          void navigator.clipboard.read().then((items) => {
            for (const item of items) {
              const imageType = item.types.find((t) => t.startsWith("image/"));
              if (imageType) {
                void item.getType(imageType).then((blob) => {
                  const ext = imageType.split("/")[1] ?? "png";
                  const name = `paste-${Date.now()}.${ext}`;
                  term.write(`\r\n\x1b[36m[uploading image...]\x1b[0m`);
                  const reader = new FileReader();
                  reader.onload = () => {
                    const base64 = (reader.result as string).split(",")[1];
                    if (!base64) return;
                    fetch(`/api/sessions/${options.sessionId}/upload`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      credentials: "include",
                      body: JSON.stringify({ name, data: base64 }),
                    }).then((res) => {
                      if (res.ok) {
                        const path = `/tmp/uploads/${name}`;
                        term.write(`\r\n\x1b[32m[saved: ${path}]\x1b[0m\r\n`);
                        // Type the path into the terminal
                        if (ws.readyState === WebSocket.OPEN) {
                          const buf = new Uint8Array(path.length + 1);
                          buf[0] = 0x30;
                          for (let j = 0; j < path.length; j++) {
                            buf[j + 1] = path.charCodeAt(j);
                          }
                          ws.send(buf.buffer);
                        }
                      } else {
                        term.write(`\r\n\x1b[31m[upload failed]\x1b[0m\r\n`);
                      }
                    }).catch(() => {
                      term.write(`\r\n\x1b[31m[upload failed]\x1b[0m\r\n`);
                    });
                  };
                  reader.readAsDataURL(blob);
                });
                return;
              }
            }
            // No image — paste text
            void navigator.clipboard.readText().then((text) => {
              if (text && ws.readyState === WebSocket.OPEN) {
                const buf = new Uint8Array(text.length + 1);
                buf[0] = 0x30; // ASCII '0' = input
                for (let i = 0; i < text.length; i++) {
                  buf[i + 1] = text.charCodeAt(i);
                }
                ws.send(buf.buffer);
              }
            });
          }).catch(() => {});
          return false;
        }
        return true;
      });

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
            if (ws.readyState === WebSocket.OPEN) {
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
      };
    },
    [options.sessionId],
  );

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      cleanupRef.current?.();
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
