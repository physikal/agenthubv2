import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import type { InfrastructureConfig } from "../../db/schema.js";
import type { AgentSessionContext } from "../../middleware/auth.js";
import { DeployError } from "../deploy-error.js";

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

/** Write a Dockerfile-free compose that builds `./` and publishes one port. */
function buildCompose(
  appName: string,
  hostPort: number,
  envVars: Record<string, string> | undefined,
): string {
  const lines: string[] = [
    "services:",
    `  ${appName}:`,
    "    build: .",
    "    restart: unless-stopped",
    "    ports:",
    `      - "${String(hostPort)}:${String(DEFAULT_CONTAINER_PORT)}"`,
  ];
  const env = { PORT: String(DEFAULT_CONTAINER_PORT), ...(envVars ?? {}) };
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
        writeFileSync(
          `${tmpDir}/docker-compose.yml`,
          buildCompose(input.name, hostPort, input.envVars),
        );
      } else if (input.composeConfig) {
        writeFileSync(`${tmpDir}/docker-compose.yml`, input.composeConfig);
      }

      updateStatus(deployId, { statusDetail: "Building + starting..." });
      await execFileAsync(
        "docker",
        ["compose", "-p", proj, "up", "-d", "--build"],
        { cwd: tmpDir, timeout: 600_000 },
      );

      // Compose emits empty strings for unset vars, so fall through on both
      // null/undefined and "". 127.0.0.1 only works when the caller is on
      // the same box — document that operators should set AGENTHUB_PUBLIC_HOST.
      const host = process.env["AGENTHUB_PUBLIC_HOST"] || "127.0.0.1";
      const url = `http://${host}:${String(hostPort)}`;

      updateStatus(deployId, {
        status: "running",
        statusDetail: null,
        url,
        composeConfig: input.composeConfig ?? null,
      });
      console.log(`[deploy] ${input.name} running on ${url}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[deploy] local ${input.name} failed: ${message}`);
      updateStatus(deployId, {
        status: "failed",
        statusDetail: message.slice(0, 500),
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
