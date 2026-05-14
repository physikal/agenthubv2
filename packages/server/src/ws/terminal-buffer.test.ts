import { describe, it, expect, afterEach } from "vitest";
import { TerminalBuffer, getBufferCapacityBytes } from "./terminal-buffer.js";

describe("TerminalBuffer", () => {
  it("returns empty for a session with no appends", () => {
    const b = new TerminalBuffer(1024);
    expect(b.drain("s1").length).toBe(0);
  });

  it("append below capacity: drain returns appended bytes verbatim", () => {
    const b = new TerminalBuffer(1024);
    b.append("s1", Buffer.from("hello world"));
    expect(b.drain("s1").toString()).toBe("hello world");
  });

  it("append over capacity: oldest bytes are evicted", () => {
    const b = new TerminalBuffer(10);
    b.append("s1", Buffer.from("0123456789ABCDEF")); // 16 bytes into capacity 10
    expect(b.drain("s1").toString()).toBe("6789ABCDEF");
  });

  it("multiple appends accumulate", () => {
    const b = new TerminalBuffer(1024);
    b.append("s1", Buffer.from("foo"));
    b.append("s1", Buffer.from("bar"));
    expect(b.drain("s1").toString()).toBe("foobar");
  });

  it("multiple appends with eviction stay consistent", () => {
    const b = new TerminalBuffer(5);
    b.append("s1", Buffer.from("abc"));
    b.append("s1", Buffer.from("defgh"));
    // capacity 5: "abc"+"defgh"=8 bytes, evict 3, keep last 5
    expect(b.drain("s1").toString()).toBe("defgh");
  });

  it("drain is non-destructive (multiple drains return full content)", () => {
    const b = new TerminalBuffer(1024);
    b.append("s1", Buffer.from("hello"));
    expect(b.drain("s1").toString()).toBe("hello");
    expect(b.drain("s1").toString()).toBe("hello");
  });

  it("free releases per-session storage", () => {
    const b = new TerminalBuffer(1024);
    b.append("s1", Buffer.from("hello"));
    b.free("s1");
    expect(b.drain("s1").length).toBe(0);
  });

  it("sessions are isolated", () => {
    const b = new TerminalBuffer(1024);
    b.append("s1", Buffer.from("hello"));
    b.append("s2", Buffer.from("world"));
    expect(b.drain("s1").toString()).toBe("hello");
    expect(b.drain("s2").toString()).toBe("world");
  });
});

describe("getBufferCapacityBytes", () => {
  const origEnv = process.env["AGENTHUB_TERMINAL_BUFFER_KB"];
  afterEach(() => {
    if (origEnv === undefined) delete process.env["AGENTHUB_TERMINAL_BUFFER_KB"];
    else process.env["AGENTHUB_TERMINAL_BUFFER_KB"] = origEnv;
  });

  it("defaults to 256 KB when env var unset", () => {
    delete process.env["AGENTHUB_TERMINAL_BUFFER_KB"];
    expect(getBufferCapacityBytes()).toBe(256 * 1024);
  });

  it("reads env var value in KB", () => {
    process.env["AGENTHUB_TERMINAL_BUFFER_KB"] = "512";
    expect(getBufferCapacityBytes()).toBe(512 * 1024);
  });

  it("clamps to lower bound (16 KB)", () => {
    process.env["AGENTHUB_TERMINAL_BUFFER_KB"] = "1";
    expect(getBufferCapacityBytes()).toBe(16 * 1024);
  });

  it("clamps to upper bound (4096 KB)", () => {
    process.env["AGENTHUB_TERMINAL_BUFFER_KB"] = "999999";
    expect(getBufferCapacityBytes()).toBe(4096 * 1024);
  });

  it("falls back to default on invalid value", () => {
    process.env["AGENTHUB_TERMINAL_BUFFER_KB"] = "not-a-number";
    expect(getBufferCapacityBytes()).toBe(256 * 1024);
  });
});
