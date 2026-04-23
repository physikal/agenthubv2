import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";

/**
 * Deploy to DigitalOcean App Platform. Creates an app pointing at a
 * GitHub repo; DO builds + runs it and hands back a `*.ondigitalocean.app`
 * URL.
 *
 * Inputs:
 *   - gitUrl: HTTPS clone URL of the user's repo (github.com)
 *   - gitBranch: branch to track (default: "main")
 *   - envVars: per-service env (flattened onto the single service we create)
 *   - name: DO app name (lowercase, hyphens)
 *
 * Poll behavior: we don't block the HTTP caller on build completion. DO
 * returns a deployment immediately; we store it with status="deploying"
 * and a background poll updates to "running" + captures `default_ingress`.
 */

export interface DOAppsDeployInput {
  userId: string;
  infraId: string;
  name: string;
  gitUrl: string;
  gitBranch?: string | undefined;
  envVars?: Record<string, string> | undefined;
  existingDeployId?: string | undefined;
}

export interface DOAppsDeployResult {
  id: string;
  url: string | null;
}

interface DOAppsConfig {
  apiToken: string;
  region?: string;
}

interface DOApp {
  id: string;
  default_ingress?: string;
  live_url?: string;
  active_deployment?: { id: string; phase: string } | null;
  in_progress_deployment?: { id: string; phase: string } | null;
}

const DO_API = "https://api.digitalocean.com/v2";

function resolveCfg(merged: Record<string, unknown>): DOAppsConfig {
  const apiToken = merged["apiToken"];
  if (typeof apiToken !== "string" || !apiToken) {
    throw new Error("DO Apps config missing apiToken");
  }
  const region = typeof merged["region"] === "string" ? merged["region"] : undefined;
  const cfg: DOAppsConfig = { apiToken };
  if (region) cfg.region = region;
  return cfg;
}

async function doRequest<T>(
  cfg: DOAppsConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const resp = await fetch(`${DO_API}${path}`, init);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`DO Apps ${method} ${path} failed (${String(resp.status)}): ${text}`);
  }
  if (resp.status === 204) return {} as T;
  return (await resp.json()) as T;
}

/** github.com/owner/repo(.git)? → owner/repo (DO's spec.services[].github.repo). */
function githubRepoFromUrl(url: string): string {
  const m = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/.exec(url);
  if (!m || !m[1] || !m[2]) {
    throw new Error(
      `DO Apps requires a github.com gitUrl, got: ${url}. Push your repo to GitHub (push_to_github MCP tool) first.`,
    );
  }
  return `${m[1]}/${m[2]}`;
}

function buildAppSpec(input: DOAppsDeployInput, region: string | undefined): Record<string, unknown> {
  const envs = Object.entries(input.envVars ?? {}).map(([key, value]) => ({
    key,
    value,
    scope: "RUN_AND_BUILD_TIME",
    type: "GENERAL",
  }));
  return {
    name: input.name,
    region: region ?? "nyc",
    services: [
      {
        name: "web",
        github: {
          repo: githubRepoFromUrl(input.gitUrl),
          branch: input.gitBranch ?? "main",
          deploy_on_push: true,
        },
        instance_size_slug: "basic-xxs",
        instance_count: 1,
        ...(envs.length ? { envs } : {}),
      },
    ],
  };
}

function updateStatus(
  deployId: string,
  patch: Partial<typeof schema.deployments.$inferInsert>,
): void {
  db.update(schema.deployments)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.deployments.id, deployId))
    .run();
}

export async function doAppsDeploy(
  _infra: unknown,
  resolvedConfig: Record<string, unknown>,
  input: DOAppsDeployInput,
): Promise<DOAppsDeployResult> {
  const cfg = resolveCfg(resolvedConfig);
  const deployId = input.existingDeployId ?? randomUUID();
  const spec = buildAppSpec(input, cfg.region);
  const isUpdate = Boolean(input.existingDeployId);

  const now = new Date();
  if (isUpdate) {
    updateStatus(deployId, { status: "deploying", statusDetail: "Updating DO app..." });
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
        statusDetail: "Creating DO app...",
        sourcePath: null,
        gitUrl: input.gitUrl,
        gitBranch: input.gitBranch ?? "main",
        buildStrategy: "git-pull",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  let appId: string;
  try {
    if (isUpdate) {
      const row = db
        .select()
        .from(schema.deployments)
        .where(eq(schema.deployments.id, deployId))
        .get();
      if (!row?.containerId) {
        throw new Error("Update requested but no DO app ID stored on deployment row");
      }
      appId = row.containerId;
      await doRequest(cfg, "PUT", `/apps/${appId}`, { spec });
    } else {
      const created = await doRequest<{ app: DOApp }>(cfg, "POST", "/apps", { spec });
      appId = created.app.id;
      updateStatus(deployId, { containerId: appId, statusDetail: "Building on DO..." });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateStatus(deployId, { status: "failed", statusDetail: msg.slice(0, 500) });
    return { id: deployId, url: null };
  }

  // Background poll: DO takes minutes for first build. Pulling the active
  // deployment's phase until ACTIVE/ERROR, then capture `default_ingress`.
  void (async () => {
    const deadline = Date.now() + 15 * 60 * 1_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15_000));
      try {
        const { app } = await doRequest<{ app: DOApp }>(cfg, "GET", `/apps/${appId}`);
        const phase =
          app.active_deployment?.phase ??
          app.in_progress_deployment?.phase ??
          "UNKNOWN";
        if (phase === "ACTIVE") {
          updateStatus(deployId, {
            status: "running",
            statusDetail: null,
            url: app.live_url ?? app.default_ingress ?? null,
          });
          return;
        }
        if (phase === "ERROR" || phase === "CANCELED") {
          updateStatus(deployId, {
            status: "failed",
            statusDetail: `DO build ${phase.toLowerCase()}`,
          });
          return;
        }
        updateStatus(deployId, { statusDetail: `DO build: ${phase.toLowerCase()}` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[deploy] do-apps poll ${deployId}: ${msg}`);
      }
    }
    updateStatus(deployId, {
      status: "failed",
      statusDetail: "DO build did not complete within 15 minutes",
    });
  })();

  return { id: deployId, url: null };
}

export async function doAppsDestroy(
  resolvedConfig: Record<string, unknown>,
  appId: string,
): Promise<void> {
  const cfg = resolveCfg(resolvedConfig);
  try {
    await doRequest(cfg, "DELETE", `/apps/${appId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 404 is fine — already gone.
    if (!/\b404\b/.test(msg)) throw err;
  }
}

export async function doAppsLogs(
  resolvedConfig: Record<string, unknown>,
  appId: string,
  lines: number,
): Promise<string> {
  const cfg = resolveCfg(resolvedConfig);
  try {
    const { app } = await doRequest<{ app: DOApp }>(cfg, "GET", `/apps/${appId}`);
    const deploymentId =
      app.active_deployment?.id ?? app.in_progress_deployment?.id ?? null;
    if (!deploymentId) return "(no deployment to tail yet)";
    const resp = await fetch(
      `${DO_API}/apps/${appId}/deployments/${deploymentId}/logs?type=RUN&follow=false`,
      { headers: { Authorization: `Bearer ${cfg.apiToken}` } },
    );
    if (!resp.ok) return `[log fetch failed: ${String(resp.status)}]`;
    const body = (await resp.json()) as { historic_urls?: string[] };
    const firstUrl = body.historic_urls?.[0];
    if (!firstUrl) return "(no historic log URL)";
    const tail = await fetch(firstUrl);
    if (!tail.ok) return `[log tail failed: ${String(tail.status)}]`;
    const text = await tail.text();
    const splitLines = text.split("\n");
    return splitLines.slice(-lines).join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[logs unavailable: ${msg}]`;
  }
}

export async function doAppsRestart(
  resolvedConfig: Record<string, unknown>,
  appId: string,
): Promise<void> {
  const cfg = resolveCfg(resolvedConfig);
  await doRequest(cfg, "POST", `/apps/${appId}/deployments`, { force_build: true });
}
