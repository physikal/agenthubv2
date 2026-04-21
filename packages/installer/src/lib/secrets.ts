import { randomBytes } from "node:crypto";

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function randomPassword(length = 24): string {
  // URL-safe base64 of 3*length/4 bytes, trimmed and substituted to avoid
  // characters that tend to break shell quoting / env parsers.
  const raw = randomBytes(Math.ceil((length * 3) / 4)).toString("base64");
  return raw.replace(/[/+=]/g, "x").slice(0, length);
}
