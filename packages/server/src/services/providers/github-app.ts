/**
 * GitHub App — platform-level identity for AgentHub. Replaces (and will
 * eventually deprecate) the per-user PAT integration in ./github.ts.
 *
 * Why a GitHub App: per-repo scoping (users pick which repos AgentHub sees),
 * 1-hour installation tokens (no long-lived secrets at rest), revocable
 * from GitHub's side with immediate effect, and a manifest-driven setup
 * that hides the "here's a private key, paste it into this form" UX.
 *
 * What lives where:
 *   - github_app_config (SQLite, single row id='default')
 *       appId, slug, clientId, name, htmlUrl, registeredByUserId
 *   - Infisical path /system/github-app/
 *       privateKey          — RS256 PEM
 *       webhookSecret       — HMAC-SHA256 shared secret
 *       clientSecret        — OAuth-on-install, unused in MVP
 *   - github_installations (SQLite)
 *       one row per (user, GitHub account installation_id)
 *
 * Public surface of this module:
 *   - isGithubAppRegistered()
 *   - loadGithubAppConfig()
 *   - mintInstallationToken(installationId)
 *   - fetchInstallationMetadata(installationId)
 *   - installUrlFor(state)
 *
 * Tokens are never persisted. Each call to mintInstallationToken hits
 * @octokit/auth-app, which handles JWT signing + an in-process LRU so
 * repeated calls within the 1-hour TTL reuse the same token.
 */
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { eq } from "drizzle-orm";

import { db, schema } from "../../db/index.js";
import { DeployError } from "../deploy-error.js";
import { getSecretStore } from "../secrets/index.js";
import { SecretStoreNotConfiguredError } from "../secrets/types.js";

export const GITHUB_APP_SECRETS_PATH = "/system/github-app";

export interface GithubAppCreds {
  appId: number;
  clientId: string;
  slug: string;
  name: string;
  htmlUrl: string;
  privateKey: string;
  webhookSecret: string;
}

export interface GithubInstallationAccount {
  installationId: number;
  login: string;
  accountType: "User" | "Organization";
  targetType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  permissions: Record<string, string>;
}

/** True when the admin has completed the manifest/manual registration flow. */
export function isGithubAppRegistered(): boolean {
  const row = db.select().from(schema.githubAppConfig).get();
  return row !== undefined;
}

/**
 * Load the fully-resolved App credentials (public metadata from SQLite +
 * secrets from Infisical). Throws DeployError(503) when the secret store
 * isn't wired, DeployError(404) when the App hasn't been registered yet.
 */
export async function loadGithubAppCreds(): Promise<GithubAppCreds> {
  const row = db.select().from(schema.githubAppConfig).get();
  if (!row) {
    throw new DeployError(
      "GitHub App not registered — an admin needs to complete setup first",
      404,
    );
  }
  const store = getSecretStore();
  if (!store.configured) {
    throw new SecretStoreNotConfiguredError();
  }
  const secrets = await store.getAllSecrets(GITHUB_APP_SECRETS_PATH);
  const privateKey = secrets["privateKey"];
  const webhookSecret = secrets["webhookSecret"];
  if (!privateKey || !webhookSecret) {
    throw new DeployError(
      "GitHub App secrets missing from the secret store — re-register the App",
      500,
    );
  }
  return {
    appId: row.appId,
    clientId: row.clientId,
    slug: row.slug,
    name: row.name,
    htmlUrl: row.htmlUrl,
    privateKey,
    webhookSecret,
  };
}

/**
 * Mint a 1-hour installation access token. Delegates JWT signing + caching
 * to @octokit/auth-app. Returns just the token string; callers that need
 * the full response (expiry, permissions snapshot) should use
 * fetchInstallationMetadata instead.
 *
 * Throws DeployError(502) when GitHub rejects the installation — typically
 * because it's been suspended or deleted from the user's side. Callers
 * should mark the stored row accordingly and prompt a re-install.
 */
export async function mintInstallationToken(installationId: number): Promise<string> {
  const creds = await loadGithubAppCreds();
  const auth = createAppAuth({
    appId: creds.appId,
    privateKey: creds.privateKey,
    installationId,
  });
  try {
    const { token } = await auth({ type: "installation" });
    return token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DeployError(
      `GitHub installation ${String(installationId)} unavailable: ${msg}`,
      502,
    );
  }
}

/**
 * Fetch metadata about an installation — used on the install callback so
 * we can persist `account_login`, `repository_selection`, etc. Hits
 * `/app/installations/{id}` with a short-lived App-level JWT; does not
 * require (and does not produce) an installation token.
 */
export async function fetchInstallationMetadata(
  installationId: number,
): Promise<GithubInstallationAccount> {
  const creds = await loadGithubAppCreds();
  const appAuth = createAppAuth({
    appId: creds.appId,
    privateKey: creds.privateKey,
  });
  const octokit = new Octokit({
    authStrategy: () => appAuth,
    auth: { type: "app" },
  });
  const { data } = await octokit.rest.apps.getInstallation({
    installation_id: installationId,
  });
  const account = data.account;
  if (!account) {
    throw new DeployError(
      `GitHub installation ${String(installationId)} has no account — aborting`,
      502,
    );
  }
  // account can be a User or an Enterprise; we only accept User/Organization.
  const login = "login" in account ? account.login : null;
  const accountType = "type" in account ? account.type : null;
  if (!login || !accountType) {
    throw new DeployError(
      `Unsupported account shape on installation ${String(installationId)}`,
      502,
    );
  }
  if (accountType !== "User" && accountType !== "Organization") {
    throw new DeployError(
      `GitHub installation account type "${String(accountType)}" is not supported — only User and Organization`,
      400,
    );
  }
  const targetType =
    data.target_type === "Organization" ? "Organization" : "User";
  return {
    installationId: data.id,
    login,
    accountType,
    targetType,
    repositorySelection:
      data.repository_selection === "selected" ? "selected" : "all",
    permissions: (data.permissions ?? {}) as Record<string, string>,
  };
}

/**
 * URL the admin / user is redirected to when starting the "install on
 * GitHub" flow. The `state` param is a one-time CSRF token the caller
 * stored in `github_install_state`; it's echoed back by GitHub to our
 * callback.
 */
export function installUrlFor(slug: string, state: string): string {
  const params = new URLSearchParams({ state });
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?${params.toString()}`;
}

/** Store / replace the single App-config row. Private key + webhook secret
 * go to Infisical; everything else stays in SQLite. Called by the manifest
 * callback (Phase 2) and the manual-setup form.
 */
export async function upsertGithubAppConfig(args: {
  appId: number;
  slug: string;
  clientId: string;
  name: string;
  htmlUrl: string;
  privateKey: string;
  webhookSecret: string;
  clientSecret?: string;
  registeredByUserId: string;
}): Promise<void> {
  const store = getSecretStore();
  if (!store.configured) {
    throw new SecretStoreNotConfiguredError();
  }
  const secretValues: Record<string, string> = {
    privateKey: args.privateKey,
    webhookSecret: args.webhookSecret,
  };
  if (args.clientSecret) secretValues["clientSecret"] = args.clientSecret;
  await store.setSecrets(GITHUB_APP_SECRETS_PATH, secretValues);

  const now = new Date();
  const existing = db.select().from(schema.githubAppConfig).get();
  if (existing) {
    db.update(schema.githubAppConfig)
      .set({
        appId: args.appId,
        slug: args.slug,
        clientId: args.clientId,
        name: args.name,
        htmlUrl: args.htmlUrl,
        registeredByUserId: args.registeredByUserId,
      })
      .where(eq(schema.githubAppConfig.id, "default"))
      .run();
  } else {
    db.insert(schema.githubAppConfig)
      .values({
        id: "default",
        appId: args.appId,
        slug: args.slug,
        clientId: args.clientId,
        name: args.name,
        htmlUrl: args.htmlUrl,
        registeredByUserId: args.registeredByUserId,
        createdAt: now,
      })
      .run();
  }
}
