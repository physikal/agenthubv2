import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import type { InfrastructureConfig } from "../../db/schema.js";
import type { AgentSessionContext } from "../../middleware/auth.js";
import { DeployError } from "../deploy-error.js";
import { firstPublishedTcpPort, parseComposePs } from "./local-deploy-ports.js";
import { resolveAgenthubHost } from "../public-host.js";

const execFileAsync = promisify(execFile);

/**
 * Deploy to AgentHub's own Docker daemon via the server container's
 * /var/run/docker.sock bind mount. The canonical "zero-setup" target —
 * user installs AgentHub, opens a session, builds an app, runs
 * `agentdeploy deploy target=local`, and the app runs on the same box
 * at `http://<AGENTHUB_PUBLIC_HOST>:<auto-port>`.
 *
 * Source comes from the caller's workspace container via `docker cp`.
 * Requires the AgentToken-authenticated caller to carry workspace
 * context (no cookie-auth deploys with source_path — those have no
 * workspace to copy from).
 */

const BASE_PORT = 8001;
const DEFAULT_CONTAINER_PORT = 3000;

export interface LocalDeployInput {
  userId: string;
  infraId: string;
  name: string;
  /** Absolute path inside the caller's workspace container. */
  sourcePath?: string | undefined;
  /** Raw docker-compose.yml text. Mutually exclusive with sourcePath. */
  composeConfig?: string | undefined;
  envVars?: Record<string, string> | undefined;
  existingDeployId?: string | undefined;
}

export interface LocalDeployResult {
  id: string;
  url: string | null;
}

/** Scan every local-docker deployment for used host ports, return first free slot. */
function nextLocalPort(): number {
  const rows = db
    .select({
      url: schema.deployments.url,
      provider: schema.infrastructureConfigs.provider,
    })
    .from(schema.deployments)
    .innerJoin(
      schema.infrastructureConfigs,
      eq(schema.deployments.infraId, schema.infrastructureConfigs.id),
    )
    .all()
    .filter(
      (r) =>
        r.provider === "local-docker" &&
        r.url !== null &&
        r.url !== "",
    );

  const used = new Set<number>();
  for (const r of rows) {
    const m = /:(\d+)(?:\/|$)/.exec(r.url ?? "");
    if (m?.[1]) used.add(parseInt(m[1], 10));
  }
  let port = BASE_PORT;
  while (used.has(port)) port += 1;
  return port;
}

/**
 * Docker Compose project name used to group this deployment's containers.
 * Prefixed so `docker compose -p <name>` reliably finds them for destroy.
 */
function projectName(appName: string, deployId: string): string {
  return `agenthub-local-${appName}-${deployId.slice(0, 8)}`;
}

/**
 * Pick the container port the user's app listens on, by introspecting
 * their Dockerfile. Mirrors the SSH-based path in deployer.ts:611-628
 * so local and remote-docker targets behave the same.
 *
 * Priority:
 *   1. Explicit `EXPOSE <port>` directive — first numeric token wins.
 *   2. FROM line — static-content base images (nginx, httpd, caddy,
 *      apache) default their server to port 80.
 *   3. Fall back to {@link DEFAULT_CONTAINER_PORT} (3000 — Node.js
 *      convention; Express/Vite/Next dev servers all default here).
 *
 * Without this detection, every Dockerfile-only project was mapped to
 * `host:port → container:3000` regardless of what the app actually
 * listened on. Nginx-based static sites returned connection refused.
 */
export function detectContainerPort(dockerfilePath: string): number {
  if (!existsSync(dockerfilePath)) return DEFAULT_CONTAINER_PORT;
  let text: string;
  try {
    text = readFileSync(dockerfilePath, "utf8");
  } catch {
    return DEFAULT_CONTAINER_PORT;
  }
  const exposeMatch = /^\s*EXPOSE\s+([0-9]+)/im.exec(text);
  if (exposeMatch?.[1]) {
    const n = parseInt(exposeMatch[1], 10);
    if (!Number.isNaN(n) && n > 0 && n < 65536) return n;
  }
  const fromMatch = /^\s*FROM\s+(\S+)/im.exec(text);
  if (fromMatch?.[1] && /^(nginx|httpd|caddy|apache)/i.test(fromMatch[1])) {
    return 80;
  }
  return DEFAULT_CONTAINER_PORT;
}

/** Largest deploy-error blob we persist to `statusDetail`. The column is
 *  unbounded SQLite TEXT, but a cap keeps the UI sane. We keep the TAIL —
 *  `docker compose` / `docker build` print the actionable failure last,
 *  after a wall of build output. */
const MAX_DEPLOY_ERROR_CHARS = 4000;

/**
 * Turn an execFile rejection into a useful failure detail. `docker compose`
 * writes the real error (port conflict, network clash, build failure) to
 * stderr; the bare `err.message` is just "Command failed: docker compose …".
 * Previously we stored `message.slice(0, 500)`, which clipped the actual
 * cause — an in-workspace agent couldn't diagnose a failed deploy because of
 * it. Prefer stderr, fall back to message, keep the tail.
 */
export function formatExecError(err: unknown): string {
  let text: string;
  if (err && typeof err === "object") {
    const e = err as { message?: string; stderr?: string };
    text = e.stderr?.trim() ? e.stderr.trim() : (e.message ?? String(err));
  } else {
    text = String(err);
  }
  return text.length > MAX_DEPLOY_ERROR_CHARS
    ? `…${text.slice(-MAX_DEPLOY_ERROR_CHARS)}`
    : text;
}

/** Write a Dockerfile-free compose that builds `./` and publishes one port. */
function buildCompose(
  appName: string,
  hostPort: number,
  containerPort: number,
  envVars: Record<string, string> | undefined,
): string {
  const lines: string[] = [
    "services:",
    `  ${appName}:`,
    "    build: .",
    "    restart: unless-stopped",
    "    ports:",
    `      - "${String(hostPort)}:${String(containerPort)}"`,
  ];
  const env = { PORT: String(containerPort), ...(envVars ?? {}) };
  lines.push("    environment:");
  for (const [k, v] of Object.entries(env)) {
    // Keep values single-line + escape double quotes.
    lines.push(`      ${k}: "${v.replace(/"/g, '\\"')}"`);
  }
  return lines.join("\n") + "\n";
}

function updateStatus(deployId: string, patch: Partial<typeof schema.deployments.$inferInsert>): void {
  db.update(schema.deployments)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.deployments.id, deployId))
    .run();
}

async function inspectPublishedPort(project: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["compose", "-p", project, "ps", "--format", "json"],
      { timeout: 10_000 },
    );
    return firstPublishedTcpPort(parseComposePs(stdout));
  } catch {
    return null;
  }
}

export async function localDockerDeploy(
  _infra: InfrastructureConfig,
  input: LocalDeployInput,
  agentSession: AgentSessionContext | undefined,
): Promise<LocalDeployResult> {
  // Validation: source_path requires a workspace container to copy from.
  if (input.sourcePath && !agentSession?.workspaceId) {
    throw new DeployError(
      "Local-docker deploys with sourcePath require an agent session — call from inside a workspace via the agentdeploy MCP, not the web UI.",
    );
  }
  if (!input.sourcePath && !input.composeConfig) {
    throw new DeployError(
      "Local-docker deploys require sourcePath (with a Dockerfile) or composeConfig",
    );
  }

  const isUpdate = Boolean(input.existingDeployId);
  const deployId = input.existingDeployId ?? randomUUID();
  const proj = projectName(input.name, deployId);

  const now = new Date();
  if (isUpdate) {
    updateStatus(deployId, {
      status: "deploying",
      statusDetail: "Updating...",
      sourcePath: input.sourcePath ?? null,
    });
  } else {
    db.insert(schema.deployments)
      .values({
        id: deployId,
        userId: input.userId,
        infraId: input.infraId,
        name: input.name,
        domain: null,
        internalOnly: false,
        status: "deploying",
        statusDetail: "Copying source...",
        sourcePath: input.sourcePath ?? null,
        containerId: proj,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  // Run the long-running build+start in the background so the HTTP caller
  // gets a fast response with the deployment ID to poll.
  void (async () => {
    const tmpDir = `/tmp/agenthub-local/${deployId}`;
    let hostPort: number | null = null;
    try {
      // Reuse the previous host port on update, else pick a fresh one.
      if (isUpdate) {
        const row = db
          .select({ url: schema.deployments.url })
          .from(schema.deployments)
          .where(eq(schema.deployments.id, deployId))
          .get();
        const m = row?.url ? /:(\d+)(?:\/|$)/.exec(row.url) : null;
        hostPort = m?.[1] ? parseInt(m[1], 10) : nextLocalPort();
      } else {
        hostPort = nextLocalPort();
      }

      rmSync(tmpDir, { recursive: true, force: true });
      mkdirSync(tmpDir, { recursive: true });

      if (input.sourcePath) {
        const workspaceContainer = `agenthub-ws-${agentSession?.workspaceId ?? ""}`;
        updateStatus(deployId, { statusDetail: "Copying source..." });
        // The trailing `/.` semantic copies the directory's contents into
        // tmpDir rather than nesting it under an extra subdir.
        await execFileAsync(
          "docker",
          ["cp", `${workspaceContainer}:${input.sourcePath}/.`, tmpDir],
          { timeout: 60_000 },
        );
        // Write our generated compose alongside the user's Dockerfile. If
        // the user also supplies a docker-compose.yml we overwrite it —
        // PR #2 scope is Dockerfile-only local deploys; compose_config
        // mode takes the other branch below.
        const containerPort = detectContainerPort(`${tmpDir}/Dockerfile`);
        writeFileSync(
          `${tmpDir}/docker-compose.yml`,
          buildCompose(input.name, hostPort, containerPort, input.envVars),
        );
      } else if (input.composeConfig) {
        writeFileSync(`${tmpDir}/docker-compose.yml`, input.composeConfig);
      }

      updateStatus(deployId, { statusDetail: "Building + starting..." });
      // Explicit `-f docker-compose.yml` (not just cwd discovery) so a magic
      // COMPOSE_FILE env var in this container's environment can never
      // redirect us at the AgentHub stack's compose file. See the
      // AGENTHUB_COMPOSE_FILE note in compose/docker-compose.yml.
      await execFileAsync(
        "docker",
        ["compose", "-p", proj, "-f", "docker-compose.yml", "up", "-d", "--build"],
        { cwd: tmpDir, timeout: 600_000 },
      );

      // Source-of-truth for the URL is what Docker actually bound, not the
      // host port we pre-picked. composeConfig callers may write random
      // (`ports: - "80"`), IP-bound (`127.0.0.1:80:80`), or range port
      // specs — all produce different actual bindings than nextLocalPort()
      // guessed. Asking docker skips the compose parsing acrobatics and
      // still works when the project has multiple services. null =
      // internal-only (no TCP publish); store url=null so the UI can hide
      // the clickable link.
      const actualPort = await inspectPublishedPort(proj);
      // resolvePublicHost prefers AGENTHUB_PUBLIC_HOST, derives from
      // AGENTHUB_PUBLIC_URL when missing, falls back to 127.0.0.1 only as a
      // last resort (works for caller-on-same-box; LAN ops set PUBLIC_URL).
      const host = resolveAgenthubHost();
      const url = actualPort ? `http://${host}:${String(actualPort)}` : null;

      updateStatus(deployId, {
        status: "running",
        statusDetail: url
          ? null
          : "running, but no TCP port is published — add a `ports:` entry to your compose to expose it",
        url,
        composeConfig: input.composeConfig ?? null,
      });
      console.log(
        url
          ? `[deploy] ${input.name} running on ${url}`
          : `[deploy] ${input.name} running (no published port)`,
      );
    } catch (err) {
      const detail = formatExecError(err);
      console.error(`[deploy] local ${input.name} failed: ${detail}`);
      updateStatus(deployId, {
        status: "failed",
        statusDetail: detail,
      });
      // Leave tmpDir in place for post-mortem; deleted on next attempt.
    }
  })();

  return { id: deployId, url: null };
}

/** Tear down a local deployment by its stored compose project name. */
export async function localDockerDestroy(composeProject: string): Promise<void> {
  try {
    await execFileAsync("docker", ["compose", "-p", composeProject, "down", "-v"], {
      timeout: 120_000,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[deploy] local destroy ${composeProject}: ${message}`);
  }
}

/** Tail recent container logs across every service in the compose project. */
export async function localDockerLogs(
  composeProject: string,
  lines: number,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["compose", "-p", composeProject, "logs", "--tail", String(lines)],
      { timeout: 30_000 },
    );
    return stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `[logs unavailable: ${message}]`;
  }
}
