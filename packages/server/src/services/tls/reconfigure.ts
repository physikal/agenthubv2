import { spawn } from "node:child_process";

export interface TlsReconfigureRequest {
  mode: "public-alpn" | "dns-01" | "self-ca";
  tlsEmail?: string;
  dnsProvider?: string;
  dnsEnvVars?: Record<string, string>;
  lanIp?: string;
}

/**
 * Spawn the agenthubv2-updater container running the reconfigure CLI.
 * Returns an async iterator of log lines suitable for piping into SSE.
 *
 * Same container pattern as `agenthub update` (see services/update.ts) so
 * privilege isolation is unchanged: the server doesn't touch docker compose
 * directly. The updater container has the install repo bind-mounted at
 * /app and the docker socket mounted, so it can run docker compose against
 * the host's compose dir.
 */
export async function* runReconfigureContainer(
  req: TlsReconfigureRequest,
  noRollback: boolean,
  regenCert: boolean,
): AsyncIterable<string> {
  const repoDir = process.env["AGENTHUB_REPO_DIR"];
  if (!repoDir) {
    throw new Error(
      "AGENTHUB_REPO_DIR not set — this endpoint requires the install's compose dir to be bind-mounted via .env. " +
        "Reinstall AgentHub or run `agenthub reconfigure-tls` from the host shell.",
    );
  }

  const env: string[] = [
    `AGENTHUB_TLS_MODE=${req.mode}`,
  ];
  if (req.tlsEmail) env.push(`AGENTHUB_TLS_EMAIL=${req.tlsEmail}`);
  if (req.dnsProvider) env.push(`AGENTHUB_TLS_DNS_PROVIDER=${req.dnsProvider}`);
  for (const [k, v] of Object.entries(req.dnsEnvVars ?? {})) {
    env.push(`${k}=${v}`);
  }
  if (req.lanIp) env.push(`AGENTHUB_LAN_IP=${req.lanIp}`);

  const cliArgs = ["--non-interactive"];
  if (noRollback) cliArgs.push("--no-rollback");
  if (regenCert) cliArgs.push("--regen-cert");

  // Docker run args: --rm so the container cleans up; bind-mount the repo
  // and docker socket; pass env vars; pin the local updater image.
  const dockerArgs = [
    "run",
    "--rm",
    "-v", `${repoDir}:/app:rw`,
    "-v", "/var/run/docker.sock:/var/run/docker.sock",
    ...env.flatMap((e) => ["-e", e]),
    "agenthubv2-updater:local",
    "node", "/app/packages/installer/dist/reconfigure-cli.js",
    ...cliArgs,
  ];

  const proc = spawn("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });

  const lines: string[] = [];
  let resolveLine: (() => void) | null = null;
  let done = false;
  let exitErr: Error | null = null;

  const onChunk = (chunk: Buffer): void => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line) lines.push(line);
    }
    if (resolveLine) {
      const r = resolveLine;
      resolveLine = null;
      r();
    }
  };
  proc.stdout.on("data", onChunk);
  proc.stderr.on("data", onChunk);
  proc.on("close", (code) => {
    done = true;
    if (code !== 0) {
      exitErr = new Error(`reconfigure container exited ${String(code)}`);
    }
    if (resolveLine) {
      const r = resolveLine;
      resolveLine = null;
      r();
    }
  });

  while (!done || lines.length > 0) {
    if (lines.length > 0) {
      yield lines.shift()!;
      continue;
    }
    if (done) break;
    await new Promise<void>((r) => {
      resolveLine = r;
    });
  }

  if (exitErr) throw exitErr;
}
