export type ProvisionerMode = "docker" | "dokploy-remote";

export interface WorkspaceCreateRequest {
  /** Stable ID we generate (used in names, labels, volume paths). */
  workspaceId: string;
  /** Used for the persistent volume name. */
  userId: string;
  /** Image to run (e.g., ghcr.io/physikal/agenthubv2-workspace:latest). */
  image: string;
  /** Env vars passed into the container (PORTAL_URL, AGENT_TOKEN, etc.). */
  env: Record<string, string>;
  /**
   * Logical volume name. The driver maps this to whatever the backing platform
   * supports (Docker named volume, Dokploy persistent storage, etc.). Reused
   * across sessions to persist /home/coder between destroys.
   */
  volumeName: string;
  /** Optional display name — surfaces in UIs where possible. */
  displayName?: string;
}

/**
 * Opaque handle. Drivers stamp it; callers persist the whole thing and pass it
 * back. We keep the shape generic so Docker's `containerId` and Dokploy's
 * `composeId` can both fit without leaking provider semantics.
 */
export interface WorkspaceRef {
  workspaceId: string;
  /** Provider-specific identifier (Docker container ID, Dokploy composeId…). */
  providerId: string;
  /** Host where it runs. For Docker: DOCKER_HOST URI / "local". For Dokploy: base URL. */
  host: string;
}

export type WorkspaceState =
  | "creating"
  | "running"
  | "stopped"
  | "destroyed"
  | "error";

export interface WorkspaceStatus {
  workspaceId: string;
  state: WorkspaceState;
  ip: string | null;
  detail: string;
}

export interface ProvisionerDriver {
  readonly mode: ProvisionerMode;

  /** Create (and usually start) a workspace. Returns once the container exists. */
  create(req: WorkspaceCreateRequest): Promise<WorkspaceRef>;

  start(ref: WorkspaceRef): Promise<void>;

  stop(ref: WorkspaceRef): Promise<void>;

  /**
   * Destroy the workspace. Volume is preserved by default so the user's
   * /home/coder survives — set keepVolume=false to purge it too.
   */
  destroy(ref: WorkspaceRef, opts?: { keepVolume?: boolean }): Promise<void>;

  status(ref: WorkspaceRef): Promise<WorkspaceStatus>;

  /**
   * Block until the workspace has an IP reachable from the AgentHub server.
   * Drivers that don't have the notion of "IP" (e.g., Dokploy, where we talk
   * to containers via the Dokploy network) should return a routable address
   * the server can WebSocket-dial.
   */
  waitForIp(ref: WorkspaceRef, timeoutMs?: number): Promise<string>;

  /** Discover all workspaces this driver manages (for reconnect-after-restart). */
  listAll(): Promise<WorkspaceRef[]>;
}
