import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import type { InfrastructureConfig } from "../../db/schema.js";
import { DeployError } from "../deploy-error.js";

/**
 * Dokploy-backed deploy path. Mirrors the public API of deployer.ts but
 * uses Dokploy's compose API instead of SSH + docker-compose.
 *
 * Config (from infra.config + Infisical secrets):
 *   { baseUrl, apiToken, projectId, environmentId }
 */

export interface DokployDeployInput {
  userId: string;
  infraId: string;
  name: string;
  domain?: string | undefined;
  composeConfig?: string | undefined;
  composePath?: string | undefined;
  /** HTTPS Git URL. When present, Dokploy clones + builds from Git
   * instead of deploying an inline compose file. Mutually exclusive
   * with composeConfig. */
  gitUrl?: string | undefined;
  /** Branch to clone. Defaults to "main". */
  gitBranch?: string | undefined;
  envVars?: Record<string, string> | undefined;
  existingDeployId?: string | undefined;
}

export interface DokployDeployResult {
  id: string;
  url: string | null;
}

interface DokployConfig {
  baseUrl: string;
  apiToken: string;
  projectId: string;
  environmentId: string;
}

interface DokployCompose {
  composeId: string;
  appName: string;
  composeType: string;
  applicationStatus: string;
}

async function dokployRequest<T>(
  cfg: DokployConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiToken,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}${path}`, init);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new DeployError(
      `Dokploy ${method} ${path} failed (${String(resp.status)}): ${text}`,
      502,
    );
  }
  return (await resp.json()) as T;
}

function resolveDokployConfig(
  merged: Record<string, unknown>,
): DokployConfig {
  const baseUrl = merged["baseUrl"] as string | undefined;
  const apiToken = merged["apiToken"] as string | undefined;
  const projectId = merged["projectId"] as string | undefined;
  const environmentId = merged["environmentId"] as string | undefined;
  if (!baseUrl || !apiToken || !projectId || !environmentId) {
    throw new DeployError(
      "Dokploy infra config missing one of: baseUrl, apiToken, projectId, environmentId",
    );
  }
  return { baseUrl, apiToken, projectId, environmentId };
}

/**
 * Create a Dokploy compose app for this deployment. Returns the deployment
 * row shape the caller persists in `deployments`.
 */
export async function dokployDeploy(
  infra: InfrastructureConfig,
  resolvedConfig: Record<string, unknown>,
  input: DokployDeployInput,
): Promise<DokployDeployResult> {
  const cfg = resolveDokployConfig(resolvedConfig);

  const appName = `agenthub-${input.name}-${randomUUID().slice(0, 8)}`.toLowerCase();
  const deployId = input.existingDeployId ?? randomUUID();
  // Two modes:
  //   git_url: Dokploy clones + builds from the caller's git remote. Dokploy
  //     reads docker-compose.yml (or `composePath`) from the repo. Used for
  //     both source_path (auto-converted upstream in deployer.ts) and
  //     explicit gitUrl input.
  //   composeConfig: caller supplied a verbatim docker-compose.yml — typically
  //     for pre-built images like n8n. Dokploy runs it as-is.
  const useGit = Boolean(input.gitUrl);
  if (!useGit && !input.composeConfig) {
    throw new DeployError(
      "Dokploy deploy requires either a git URL (derived from source_path or passed explicitly) or composeConfig",
    );
  }
  const composeYaml = useGit ? "" : (input.composeConfig as string);
  const gitBranch = input.gitBranch ?? "main";

  let composeId: string;
  if (input.existingDeployId) {
    const row = db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, input.existingDeployId))
      .get();
    if (!row?.containerId) {
      throw new Error(
        `Update requested for ${input.existingDeployId} but no Dokploy composeId stored`,
      );
    }
    composeId = row.containerId;
  } else {
    const created = await dokployRequest<DokployCompose>(
      cfg,
      "POST",
      "/api/compose.create",
      {
        name: input.name,
        appName,
        environmentId: cfg.environmentId,
        description: `AgentHub deploy for user ${input.userId}`,
      },
    );
    composeId = created.composeId;
  }

  // Switch Dokploy's sourceType based on what the caller gave us.
  //  - git: Dokploy clones `customGitUrl`@`customGitBranch` and uses the
  //    `docker-compose.yml` at the repo root (or `composePath` if given).
  //  - raw: We hand Dokploy a verbatim compose YAML string.
  if (useGit) {
    await dokployRequest(cfg, "POST", "/api/compose.update", {
      composeId,
      composeType: "docker-compose",
      sourceType: "git",
      customGitUrl: input.gitUrl,
      customGitBranch: gitBranch,
      ...(input.composePath ? { composePath: input.composePath } : {}),
    });
  } else {
    await dokployRequest(cfg, "POST", "/api/compose.update", {
      composeId,
      composeType: "raw",
      sourceType: "raw",
      composeFile: composeYaml,
    });
  }

  await dokployRequest(cfg, "POST", "/api/compose.deploy", {
    composeId,
    title: input.existingDeployId ? "update" : "initial deploy",
    description: input.name,
  });

  const url = input.domain ? `https://${input.domain}` : null;

  const now = new Date();
  if (input.existingDeployId) {
    db.update(schema.deployments)
      .set({
        status: "running",
        statusDetail: null,
        url,
        composeConfig: useGit ? null : composeYaml,
        gitUrl: input.gitUrl ?? null,
        gitBranch: useGit ? gitBranch : null,
        buildStrategy: useGit ? "git-pull" : "compose-inline",
        updatedAt: now,
      })
      .where(eq(schema.deployments.id, input.existingDeployId))
      .run();
  } else {
    db.insert(schema.deployments)
      .values({
        id: deployId,
        userId: input.userId,
        infraId: infra.id,
        name: input.name,
        domain: input.domain ?? null,
        internalOnly: false,
        status: "running",
        statusDetail: null,
        url,
        containerId: composeId, // store Dokploy composeId here for later ops
        composeConfig: useGit ? null : composeYaml,
        gitUrl: input.gitUrl ?? null,
        gitBranch: useGit ? gitBranch : null,
        buildStrategy: useGit ? "git-pull" : "compose-inline",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  return { id: deployId, url };
}

export async function dokployLogs(
  resolvedConfig: Record<string, unknown>,
  composeId: string,
  lines: number,
): Promise<string> {
  const cfg = resolveDokployConfig(resolvedConfig);
  const resp = await fetch(
    `${cfg.baseUrl.replace(/\/$/, "")}/api/compose.logs?composeId=${encodeURIComponent(composeId)}&tail=${String(lines)}`,
    { headers: { "x-api-key": cfg.apiToken } },
  );
  if (!resp.ok) {
    throw new Error(`Dokploy logs fetch failed (${String(resp.status)})`);
  }
  return resp.text();
}

export async function dokployRestart(
  resolvedConfig: Record<string, unknown>,
  composeId: string,
): Promise<void> {
  const cfg = resolveDokployConfig(resolvedConfig);
  await dokployRequest(cfg, "POST", "/api/compose.deploy", {
    composeId,
    title: "restart",
    description: "manual restart via AgentHub",
  });
}

export async function dokployDestroy(
  resolvedConfig: Record<string, unknown>,
  composeId: string,
): Promise<void> {
  const cfg = resolveDokployConfig(resolvedConfig);
  await dokployRequest(cfg, "POST", "/api/compose.delete", {
    composeId,
    deleteVolumes: true,
  });
}
