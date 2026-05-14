const DEFAULT_CAPACITY_KB = 256;
const MIN_CAPACITY_KB = 16;
const MAX_CAPACITY_KB = 4096;

export function getBufferCapacityBytes(): number {
  const raw = process.env["AGENTHUB_TERMINAL_BUFFER_KB"];
  if (!raw) return DEFAULT_CAPACITY_KB * 1024;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CAPACITY_KB * 1024;
  const clamped = Math.min(Math.max(n, MIN_CAPACITY_KB), MAX_CAPACITY_KB);
  return clamped * 1024;
}

/**
 * Per-session ring buffer of bytes that flowed through the terminal proxy
 * to the browser. On a fresh browser WS connection, `drain` is called to
 * replay this content before live forwarding starts. Drain is intentionally
 * non-destructive so concurrent or sequential reconnects each get the
 * full replay.
 */
export class TerminalBuffer {
  private buffers = new Map<string, Buffer>();
  private capacity: number;

  constructor(capacity = getBufferCapacityBytes()) {
    this.capacity = capacity;
  }

  append(sessionId: string, chunk: Buffer): void {
    const existing = this.buffers.get(sessionId);
    if (!existing) {
      this.buffers.set(
        sessionId,
        chunk.length <= this.capacity
          ? Buffer.from(chunk)
          : chunk.subarray(chunk.length - this.capacity),
      );
      return;
    }
    const combined = Buffer.concat([existing, chunk]);
    if (combined.length <= this.capacity) {
      this.buffers.set(sessionId, combined);
    } else {
      this.buffers.set(sessionId, combined.subarray(combined.length - this.capacity));
    }
  }

  drain(sessionId: string): Buffer {
    return this.buffers.get(sessionId) ?? Buffer.alloc(0);
  }

  free(sessionId: string): void {
    this.buffers.delete(sessionId);
  }
}

/**
 * Module-level singleton. Used by terminal-proxy.ts.
 */
export const terminalBuffers = new TerminalBuffer();
