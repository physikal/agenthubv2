import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import {
  disablePages,
  enablePages,
  latestPagesBuild,
} from "../providers/github.js";
import { requireGitHubCreds } from "../providers/github-pages.js";

/**
 * Enable (or re-point) GitHub Pages on a repo under the user's
 * configured GitHub owner. Assumes the repo is already pushed with
 * static HTML at the root of `branch`. URL is deterministic:
 * `https://<owner>.github.io/<repo>`.
 *
 * Polls `pages/builds/latest` in the background for up to 5 minutes to
 * flip the row from "deploying" → "running" once the first build
 * finishes.
 */

export interface GhPagesDeployInput {
  userId: string;
  infraId: string;
  name: string;
  gitUrl: string;
  gitBranch?: string | undefined;
  existingDeployId?: string | undefined;
}

export interface GhPagesDeployResult {
  id: string;
  url: string | null;
}

interface ParsedRepo {
  owner: string;
  repo: string;
}

function parseGithubUrl(url: string): ParsedRepo {
  const m = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/.exec(url);
  if (!m || !m[1] || !m[2]) {
    throw new Error(`GH Pages requires a github.com URL, got: ${url}`);
  }
  return { owner: m[1], repo: m[2] };
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

export async function ghPagesDeploy(
  _infra: unknown,
  input: GhPagesDeployInput,
): Promise<GhPagesDeployResult> {
  const creds = await requireGitHubCreds(input.userId);
  const parsed = parseGithubUrl(input.gitUrl);
  if (parsed.owner !== creds.owner) {
    throw new Error(
      `GH Pages can only deploy repos owned by the configured github integration (${creds.owner}); got ${parsed.owner}`,
    );
  }
  const branch = input.gitBranch ?? "main";
  const deployId = input.existingDeployId ?? randomUUID();
  const isUpdate = Boolean(input.existingDeployId);

  const now = new Date();
  if (isUpdate) {
    updateStatus(deployId, {
      status: "deploying",
      statusDetail: "Updating Pages source...",
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
        statusDetail: "Enabling Pages...",
        sourcePath: null,
        gitUrl: input.gitUrl,
        gitBranch: branch,
        buildStrategy: "git-pull",
        // Store owner/repo so destroy can call the DELETE Pages endpoint.
        containerId: `${parsed.owner}/${parsed.repo}`,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  let url: string;
  try {
    const result = await enablePages(creds, parsed.repo, branch);
    url = result.url;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateStatus(deployId, { status: "failed", statusDetail: msg.slice(0, 500) });
    return { id: deployId, url: null };
  }

  updateStatus(deployId, { url, statusDetail: "Waiting for first build..." });

  // Background poll: Pages takes 30-60s for the first build, longer on
  // Actions-based sources. Stop at 5 minutes.
  void (async () => {
    const deadline = Date.now() + 5 * 60 * 1_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10_000));
      try {
        const latest = await latestPagesBuild(creds, parsed.repo);
        if (!latest) {
          updateStatus(deployId, { statusDetail: "No build yet — waiting..." });
          continue;
        }
        if (latest.status === "built") {
          updateStatus(deployId, { status: "running", statusDetail: null });
          return;
        }
        if (latest.status === "errored") {
          updateStatus(deployId, {
            status: "failed",
            statusDetail: latest.error ?? "Pages build errored",
          });
          return;
        }
        updateStatus(deployId, { statusDetail: `Pages build: ${latest.status}` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[deploy] gh-pages poll ${deployId}: ${msg}`);
      }
    }
    updateStatus(deployId, {
      status: "failed",
      statusDetail: "Pages build did not complete within 5 minutes",
    });
  })();

  return { id: deployId, url };
}

export async function ghPagesDestroy(userId: string, ownerRepo: string): Promise<void> {
  const creds = await requireGitHubCreds(userId);
  const [, repo] = ownerRepo.split("/");
  if (!repo) return;
  await disablePages(creds, repo);
}
