import { dump as yamlDump } from "js-yaml";
import type {
  ProvisionerDriver,
  WorkspaceCreateRequest,
  WorkspaceRef,
  WorkspaceStatus,
} from "./types.js";

const AGENT_PORT = 9876;
const TTYD_PORT = 7681;

export interface DokployDriverOptions {
  /** Base URL of the Dokploy instance, e.g. https://dokploy.example.com */
  baseUrl: string;
  /** API token issued from a Dokploy user's profile settings. */
  apiToken: string;
  /** Dokploy project ID apps should live under. */
  projectId: string;
  /** Dokploy environment ID (Dokploy's "env" within a project). */
  environmentId: string;
}

interface DokployCompose {
  composeId: string;
  appName: string;
  composeType: string;
  applicationStatus: string;
}

/**
 * Talks to Dokploy's HTTP API to create a compose app per workspace.
 */
export class DokployDriver implements ProvisionerDriver {
  readonly mode = "dokploy-remote" as const;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly projectId: string;
  private readonly environmentId: string;

  constructor(opts: DokployDriverOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.projectId = opts.projectId;
    this.environmentId = opts.environmentId;
    this.headers = {
      "Content-Type": "application/json",
      "x-api-key": opts.apiToken,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const init: RequestInit = { method, headers: this.headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const resp = await fetch(`${this.baseUrl}${path}`, init);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `Dokploy ${method} ${path} failed (${String(resp.status)}): ${text}`,
      );
    }
    return (await resp.json()) as T;
  }

  async create(req: WorkspaceCreateRequest): Promise<WorkspaceRef> {
    const appName = `agenthub-ws-${req.workspaceId}`;

    // 1. Create the compose entry
    const compose = await this.request<DokployCompose>(
      "POST",
      "/api/compose.create",
      {
        name: req.displayName ?? appName,
        appName,
        environmentId: this.environmentId,
        description: `AgentHub workspace for user ${req.userId}`,
      },
    );

    // 2. Upload the raw compose yaml
    const composeYaml = this.renderCompose(req, appName);
    await this.request("POST", "/api/compose.update", {
      composeId: compose.composeId,
      composeType: "raw",
      sourceType: "raw",
      composeFile: composeYaml,
    });

    // 3. Deploy
    await this.request("POST", "/api/compose.deploy", {
      composeId: compose.composeId,
      title: "initial deploy",
      description: `workspace ${req.workspaceId}`,
    });

    return {
      workspaceId: req.workspaceId,
      providerId: compose.composeId,
      host: this.baseUrl,
    };
  }

  private renderCompose(
    req: WorkspaceCreateRequest,
    appName: string,
  ): string {
    const doc = {
      services: {
        workspace: {
          image: req.image,
          container_name: appName,
          restart: "unless-stopped",
          environment: req.env,
          expose: [String(AGENT_PORT), String(TTYD_PORT)],
          volumes: [`${req.volumeName}:/home/coder`],
          labels: {
            "io.agenthub.workspace": "true",
            "io.agenthub.workspaceId": req.workspaceId,
            "io.agenthub.userId": req.userId,
          },
        },
      },
      volumes: {
        [req.volumeName]: null,
      },
    };
    return yamlDump(doc);
  }

  async start(ref: WorkspaceRef): Promise<void> {
    await this.request("POST", "/api/compose.start", {
      composeId: ref.providerId,
    });
  }

  async stop(ref: WorkspaceRef): Promise<void> {
    await this.request("POST", "/api/compose.stop", {
      composeId: ref.providerId,
    });
  }

  async destroy(
    ref: WorkspaceRef,
    opts?: { keepVolume?: boolean },
  ): Promise<void> {
    await this.request("POST", "/api/compose.delete", {
      composeId: ref.providerId,
      deleteVolumes: opts?.keepVolume === false,
    });
  }

  async status(ref: WorkspaceRef): Promise<WorkspaceStatus> {
    try {
      const app = await this.request<DokployCompose>(
        "GET",
        `/api/compose.one?composeId=${encodeURIComponent(ref.providerId)}`,
      );
      const state = mapDokployStatus(app.applicationStatus);
      return {
        workspaceId: ref.workspaceId,
        state,
        // Dokploy does not expose the internal container IP via API; the
        // service name is the routable hostname within the Dokploy network.
        ip: state === "running" ? `agenthub-ws-${ref.workspaceId}` : null,
        detail: app.applicationStatus,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      if (msg.includes("404")) {
        return {
          workspaceId: ref.workspaceId,
          state: "destroyed",
          ip: null,
          detail: "not found",
        };
      }
      return {
        workspaceId: ref.workspaceId,
        state: "error",
        ip: null,
        detail: msg,
      };
    }
  }

  async waitForIp(ref: WorkspaceRef, timeoutMs = 120_000): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const s = await this.status(ref);
      if (s.state === "running" && s.ip) return s.ip;
      if (s.state === "destroyed") {
        throw new Error(`Workspace ${ref.workspaceId} was destroyed`);
      }
      await sleep(2_000);
    }
    throw new Error(
      `Workspace ${ref.workspaceId} did not become reachable within ${String(timeoutMs)}ms`,
    );
  }

  async listAll(): Promise<WorkspaceRef[]> {
    const res = await this.request<{ composes: DokployCompose[] }>(
      "GET",
      `/api/compose.byEnvironmentId?environmentId=${encodeURIComponent(this.environmentId)}`,
    );
    return (res.composes ?? [])
      .filter((c) => c.appName.startsWith("agenthub-ws-"))
      .map((c) => ({
        workspaceId: c.appName.replace(/^agenthub-ws-/, ""),
        providerId: c.composeId,
        host: this.baseUrl,
      }));
  }
}

function mapDokployStatus(
  s: string,
): WorkspaceStatus["state"] {
  switch (s) {
    case "running":
    case "done":
      return "running";
    case "idle":
    case "stopped":
      return "stopped";
    case "error":
      return "error";
    default:
      return "creating";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
