import { execFile } from "node:child_process";

/**
 * Shell-safety helpers.
 *
 * We SSH to Proxmox nodes as root and the remote side runs commands through bash.
 * That means every interpolated value lands in a shell context on the hypervisor —
 * command injection here is full RCE on the PVE host.
 *
 * Two rules:
 *   1. Validate every user-supplied string against an allowlist regex BEFORE it
 *      reaches the shell. Reject fail-closed.
 *   2. When we must concatenate strings into a shell command, wrap each piece
 *      in `shQuote()` so that even a regex miss is contained.
 *
 * Prefer `sshWriteFile` over heredoc interpolation for any file whose content
 * is user-supplied (Dockerfile, compose file, agent .env).
 */

export const SSH_KEY_PATH = "/tmp/pve-ssh-key";
export const SSH_OPTS: readonly string[] = [
  "-o", "StrictHostKeyChecking=no",
  "-o", "UserKnownHostsFile=/dev/null",
  "-i", SSH_KEY_PATH,
];

/** Wrap a string in single quotes for safe bash inclusion. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const NODE_RE = /^pve0[5-9]$/;
const STORAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const B2_BUCKET_RE = /^[a-z0-9][a-z0-9-]{4,48}[a-z0-9]$/;
const B2_CRED_RE = /^[A-Za-z0-9+/=_-]{1,128}$/;
const DEPLOYMENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertSafeNode(node: string): void {
  if (!NODE_RE.test(node)) {
    throw new Error(`Invalid PVE node: ${node}`);
  }
}

export function assertSafeStorage(storage: string): void {
  if (!STORAGE_RE.test(storage)) {
    throw new Error(`Invalid storage name: ${storage}`);
  }
}

export function assertSafeBucketName(bucket: string): void {
  if (!B2_BUCKET_RE.test(bucket)) {
    throw new Error("Invalid B2 bucket name (expected lowercase alphanumeric + hyphens, 6-50 chars)");
  }
}

export function assertSafeB2Credential(cred: string, field: string): void {
  if (!B2_CRED_RE.test(cred)) {
    throw new Error(`Invalid ${field} (must be alphanumeric)`);
  }
}

export function assertSafeDeploymentName(name: string): void {
  if (!DEPLOYMENT_NAME_RE.test(name)) {
    throw new Error(`Invalid deployment name: ${name}`);
  }
}

export function assertSafeUserId(userId: string): void {
  if (!USER_ID_RE.test(userId)) {
    throw new Error(`Invalid user id: ${userId}`);
  }
}

/**
 * Write a file on a remote host by piping content through SSH stdin.
 *
 * Unlike `cat > file << 'EOF'\n${content}\nEOF`, this is immune to heredoc
 * terminators in the content (a classic escape: content containing `EOF` on
 * its own line breaks out of the heredoc and executes following lines).
 *
 * `remotePath` is shell-quoted so it is safe to include arbitrary paths; the
 * caller should still validate paths against their own allowlist where possible.
 */
export function sshWriteFile(
  ip: string,
  remotePath: string,
  content: string,
  opts: { timeoutMs?: number; mode?: number } = {},
): Promise<void> {
  const { timeoutMs = 120_000, mode } = opts;
  const quotedPath = shQuote(remotePath);
  const remoteCmd = mode !== undefined
    ? `cat > ${quotedPath} && chmod ${mode.toString(8)} ${quotedPath}`
    : `cat > ${quotedPath}`;

  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      "ssh",
      [...SSH_OPTS, `root@${ip}`, remoteCmd],
      { timeout: timeoutMs },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
    child.stdin?.on("error", reject);
    child.stdin?.end(content);
  });
}

/**
 * Write a file inside an LXC container by piping through ssh -> pct exec.
 *
 * Uses the same stdin-piping trick so the file content never touches a shell.
 * `remotePath` is shell-quoted at both layers (pve host + container bash -c).
 */
export function pctWriteFile(
  pveIp: string,
  vmid: number,
  remotePath: string,
  content: string,
  opts: { timeoutMs?: number; mode?: number } = {},
): Promise<void> {
  const { timeoutMs = 120_000, mode } = opts;
  const quotedPath = shQuote(remotePath);
  const innerCmd = mode !== undefined
    ? `cat > ${quotedPath} && chmod ${mode.toString(8)} ${quotedPath}`
    : `cat > ${quotedPath}`;
  const vmidStr = String(vmid);
  if (!/^\d+$/.test(vmidStr)) throw new Error(`Invalid vmid: ${vmidStr}`);

  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      "ssh",
      [...SSH_OPTS, `root@${pveIp}`, `pct exec ${vmidStr} -- bash -c ${shQuote(innerCmd)}`],
      { timeout: timeoutMs },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
    child.stdin?.on("error", reject);
    child.stdin?.end(content);
  });
}
