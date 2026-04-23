import { and, eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { resolveInfraConfig } from "../secrets/helpers.js";

/**
 * GitHub auth integration — NOT a hosting provider (agents don't "deploy
 * to GitHub" as a runtime target). The integration stores the user's PAT
 * so other providers (DO App Platform, GitHub Pages) can:
 *   - create a repo on demand
 *   - push local source to that repo
 *   - read repo metadata
 *
 * Token scope: fine-grained PAT with
 *   `administration:write` + `contents:write` + `pages:write`
 * restricted to a single org/user. Stored in Infisical via the
 * existing splitSecrets path (/users/{userId}/integrations/github).
 */

export interface GitHubCreds {
  pat: string;
  /** Default owner for new repos (user login or org). */
  owner: string;
}

export async function loadGitHubCreds(userId: string): Promise<GitHubCreds | null> {
  const row = db
    .select()
    .from(schema.infrastructureConfigs)
    .where(
      and(
        eq(schema.infrastructureConfigs.userId, userId),
        eq(schema.infrastructureConfigs.provider, "github"),
        eq(schema.infrastructureConfigs.status, "ready"),
      ),
    )
    .get();
  if (!row) return null;

  const merged = (await resolveInfraConfig(
    userId,
    row.id,
    JSON.parse(row.config) as Record<string, unknown>,
  )) as { pat?: string; owner?: string };

  if (!merged.pat || !merged.owner) return null;
  return { pat: merged.pat, owner: merged.owner };
}

async function gh<T>(
  creds: GitHubCreds,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${creds.pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const resp = await fetch(`https://api.github.com${path}`, init);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub ${method} ${path} failed (${String(resp.status)}): ${text}`);
  }
  // 204 No Content → return empty object.
  if (resp.status === 204) return {} as T;
  return (await resp.json()) as T;
}

/** Verify PAT can read the authenticated user + return the login. */
export async function verifyGitHubPat(pat: string): Promise<{ login: string } | null> {
  try {
    const resp = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { login: string };
    return { login: body.login };
  } catch {
    return null;
  }
}

export interface Repo {
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  visibility: "public" | "private";
}

/** Check whether a repo exists under `creds.owner`. */
export async function getRepo(creds: GitHubCreds, name: string): Promise<Repo | null> {
  try {
    const r = await gh<{
      name: string;
      full_name: string;
      clone_url: string;
      default_branch: string;
      visibility: string;
    }>(creds, "GET", `/repos/${creds.owner}/${name}`);
    return {
      name: r.name,
      fullName: r.full_name,
      cloneUrl: r.clone_url,
      defaultBranch: r.default_branch,
      visibility: r.visibility === "private" ? "private" : "public",
    };
  } catch (err) {
    if (err instanceof Error && /\b404\b/.test(err.message)) return null;
    throw err;
  }
}

/**
 * Create a repo under `creds.owner` if it doesn't exist. Returns the
 * existing or newly-created repo. When `owner` is an org the endpoint
 * is /orgs/{owner}/repos; when it's a user, /user/repos.
 */
export async function createRepoIfMissing(
  creds: GitHubCreds,
  name: string,
  opts: { private?: boolean; description?: string; autoInit?: boolean } = {},
): Promise<Repo> {
  const existing = await getRepo(creds, name);
  if (existing) return existing;

  // Detect user vs org by trying /users/{owner}; GET returns `type`.
  const who = await gh<{ type: "User" | "Organization" }>(
    creds,
    "GET",
    `/users/${creds.owner}`,
  );

  const body = {
    name,
    private: opts.private ?? false,
    description: opts.description,
    auto_init: opts.autoInit ?? false,
  };
  const path = who.type === "Organization" ? `/orgs/${creds.owner}/repos` : "/user/repos";
  const r = await gh<{
    name: string;
    full_name: string;
    clone_url: string;
    default_branch: string;
    visibility: string;
  }>(creds, "POST", path, body);

  return {
    name: r.name,
    fullName: r.full_name,
    cloneUrl: r.clone_url,
    defaultBranch: r.default_branch ?? "main",
    visibility: r.visibility === "private" ? "private" : "public",
  };
}

/** Enable GitHub Pages on a repo, serving from `branch` at `/`. */
export async function enablePages(
  creds: GitHubCreds,
  repo: string,
  branch: string,
): Promise<{ url: string }> {
  // 409 if already enabled — treat as success + call PUT to set the source.
  try {
    await gh(creds, "POST", `/repos/${creds.owner}/${repo}/pages`, {
      source: { branch, path: "/" },
      build_type: "legacy",
    });
  } catch (err) {
    if (!(err instanceof Error) || !/\b409\b/.test(err.message)) throw err;
  }
  // Ensure the source is current + fetch the URL.
  await gh(creds, "PUT", `/repos/${creds.owner}/${repo}/pages`, {
    source: { branch, path: "/" },
    build_type: "legacy",
    https_enforced: true,
  });
  const info = await gh<{ html_url: string }>(
    creds,
    "GET",
    `/repos/${creds.owner}/${repo}/pages`,
  );
  return { url: info.html_url };
}

export async function disablePages(creds: GitHubCreds, repo: string): Promise<void> {
  try {
    await gh(creds, "DELETE", `/repos/${creds.owner}/${repo}/pages`);
  } catch (err) {
    if (err instanceof Error && /\b404\b/.test(err.message)) return;
    throw err;
  }
}

/** Latest Pages build summary — used to drive the UI's "deploying" state. */
export async function latestPagesBuild(
  creds: GitHubCreds,
  repo: string,
): Promise<{ status: string; error: string | null } | null> {
  try {
    const r = await gh<{ status: string; error: { message: string | null } | null }>(
      creds,
      "GET",
      `/repos/${creds.owner}/${repo}/pages/builds/latest`,
    );
    return { status: r.status, error: r.error?.message ?? null };
  } catch (err) {
    if (err instanceof Error && /\b404\b/.test(err.message)) return null;
    throw err;
  }
}
