import Docker from "dockerode";
import { existsSync } from "node:fs";
import type {
  ProvisionerDriver,
  WorkspaceCreateRequest,
  WorkspaceRef,
  WorkspaceStatus,
} from "./types.js";

/** Label we stamp on every workspace so listAll() can find them. */
const MANAGED_LABEL = "io.agenthub.workspace";
const WORKSPACE_ID_LABEL = "io.agenthub.workspaceId";

const AGENT_PORT = 9876;
const TTYD_PORT = 7681;

function assertNoHostSocket(): void {
  if (process.env["AGENTHUB_ALLOW_SOCKET_MOUNT"] === "true") return;
  if (!existsSync("/var/run/docker.sock")) return;
  if (process.env["DOCKER_HOST"]) return; // explicit TCP host is fine

  throw new Error(
    "Refusing to start: /var/run/docker.sock is mounted into this " +
      "container, which gives AgentHub root-equivalent access to the host. " +
      "Connect to a rootless Docker daemon via DOCKER_HOST=tcp://...  " +
      "(set AGENTHUB_ALLOW_SOCKET_MOUNT=true to override — NOT recommended).",
  );
}

export interface DockerDriverOptions {
  /** Rootless daemon URI, e.g. tcp://127.0.0.1:2375 or unix:///run/user/1000/docker.sock. */
  dockerHost?: string;
  /** Name of the Docker network workspaces attach to. Created if missing. */
  network?: string;
  /** Hostname prefix for workspaces (for readability in `docker ps`). */
  namePrefix?: string;
}

export class DockerDriver implements ProvisionerDriver {
  readonly mode = "docker" as const;
  private readonly docker: Docker;
  private readonly network: string;
  private readonly namePrefix: string;
  private readonly host: string;

  constructor(opts: DockerDriverOptions = {}) {
    assertNoHostSocket();
    const dockerHost = opts.dockerHost ?? process.env["DOCKER_HOST"];
    if (dockerHost) {
      const url = new URL(dockerHost);
      if (url.protocol === "tcp:") {
        this.docker = new Docker({
          host: url.hostname,
          port: Number(url.port || "2375"),
        });
      } else if (url.protocol === "unix:") {
        this.docker = new Docker({ socketPath: url.pathname });
      } else {
        throw new Error(`Unsupported DOCKER_HOST protocol: ${url.protocol}`);
      }
      this.host = dockerHost;
    } else {
      // Fallback to dockerode's default (this will try to use the socket; the
      // assertNoHostSocket guard above ensures we don't do this on accident
      // when AgentHub itself runs in a container).
      this.docker = new Docker();
      this.host = "local";
    }
    this.network = opts.network ?? "agenthub";
    this.namePrefix = opts.namePrefix ?? "agenthub-ws";
  }

  async ensureNetwork(): Promise<void> {
    const nets = await this.docker.listNetworks({
      filters: { name: [this.network] },
    });
    if (nets.some((n) => n.Name === this.network)) return;
    await this.docker.createNetwork({ Name: this.network, Driver: "bridge" });
  }

  async create(req: WorkspaceCreateRequest): Promise<WorkspaceRef> {
    await this.ensureNetwork();

    await this.ensureVolume(req.volumeName, req.userId);

    const name = `${this.namePrefix}-${req.workspaceId}`;
    const envEntries = Object.entries(req.env).map(
      ([k, v]) => `${k}=${v}`,
    );

    const container = await this.docker.createContainer({
      Image: req.image,
      name,
      Env: envEntries,
      Labels: {
        [MANAGED_LABEL]: "true",
        [WORKSPACE_ID_LABEL]: req.workspaceId,
        "io.agenthub.userId": req.userId,
      },
      ExposedPorts: {
        [`${AGENT_PORT}/tcp`]: {},
        [`${TTYD_PORT}/tcp`]: {},
      },
      HostConfig: {
        NetworkMode: this.network,
        Binds: [`${req.volumeName}:/home/coder`],
        RestartPolicy: { Name: "unless-stopped" },
        // No --privileged. No socket mount. Rootless friendly.
      },
    });

    await container.start();

    return {
      workspaceId: req.workspaceId,
      providerId: container.id,
      host: this.host,
    };
  }

  private async ensureVolume(name: string, userId: string): Promise<void> {
    try {
      await this.docker.getVolume(name).inspect();
      return;
    } catch {
      // fall through to create
    }
    await this.docker.createVolume({
      Name: name,
      Labels: {
        [MANAGED_LABEL]: "true",
        "io.agenthub.userId": userId,
      },
    });
  }

  async start(ref: WorkspaceRef): Promise<void> {
    const c = this.docker.getContainer(ref.providerId);
    try {
      await c.start();
    } catch (err) {
      if (isAlreadyStarted(err)) return;
      throw err;
    }
  }

  async stop(ref: WorkspaceRef): Promise<void> {
    const c = this.docker.getContainer(ref.providerId);
    try {
      await c.stop({ t: 10 });
    } catch (err) {
      if (isAlreadyStopped(err)) return;
      throw err;
    }
  }

  async destroy(
    ref: WorkspaceRef,
    opts?: { keepVolume?: boolean },
  ): Promise<void> {
    const c = this.docker.getContainer(ref.providerId);
    try {
      await c.remove({ force: true, v: opts?.keepVolume === false });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async status(ref: WorkspaceRef): Promise<WorkspaceStatus> {
    try {
      const info = await this.docker.getContainer(ref.providerId).inspect();
      const running = info.State.Running;
      const ip =
        info.NetworkSettings.Networks[this.network]?.IPAddress || null;
      return {
        workspaceId: ref.workspaceId,
        state: running ? "running" : "stopped",
        ip,
        detail: info.State.Status ?? "",
      };
    } catch (err) {
      if (isNotFound(err)) {
        return {
          workspaceId: ref.workspaceId,
          state: "destroyed",
          ip: null,
          detail: "container not found",
        };
      }
      throw err;
    }
  }

  async waitForIp(ref: WorkspaceRef, timeoutMs = 60_000): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const s = await this.status(ref);
      if (s.state === "running" && s.ip) return s.ip;
      if (s.state === "destroyed") {
        throw new Error(`Workspace ${ref.workspaceId} was destroyed`);
      }
      await sleep(1_000);
    }
    throw new Error(
      `Workspace ${ref.workspaceId} did not report an IP within ${String(timeoutMs)}ms`,
    );
  }

  async listAll(): Promise<WorkspaceRef[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${MANAGED_LABEL}=true`] },
    });
    return containers.map((c) => ({
      workspaceId: c.Labels[WORKSPACE_ID_LABEL] ?? c.Id,
      providerId: c.Id,
      host: this.host,
    }));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isNotFound(err: unknown): boolean {
  return hasStatusCode(err, 404);
}
function isAlreadyStarted(err: unknown): boolean {
  return hasStatusCode(err, 304);
}
function isAlreadyStopped(err: unknown): boolean {
  return hasStatusCode(err, 304);
}
function hasStatusCode(err: unknown, code: number): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    (err as { statusCode: unknown }).statusCode === code
  );
}
