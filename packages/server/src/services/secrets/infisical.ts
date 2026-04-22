import { InfisicalSDK } from "@infisical/sdk";
import type { SecretStore } from "./types.js";

/**
 * Infisical-backed secret store.
 *
 * Uses Universal Auth (machine identity). Credentials come from env:
 *   INFISICAL_URL           (e.g., http://infisical:8080)
 *   INFISICAL_CLIENT_ID
 *   INFISICAL_CLIENT_SECRET
 *   INFISICAL_PROJECT_ID
 *   INFISICAL_ENVIRONMENT   (defaults to "prod")
 */
export interface InfisicalConfig {
  url: string;
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
}

export class InfisicalStore implements SecretStore {
  readonly configured = true;
  private readonly cfg: InfisicalConfig;
  private client: InfisicalSDK | null = null;
  private authPromise: Promise<InfisicalSDK> | null = null;
  /** Paths we've already ensured exist this process lifetime. */
  private readonly ensuredFolders = new Set<string>();

  constructor(cfg: InfisicalConfig) {
    this.cfg = cfg;
  }

  /**
   * Ensure the folder at `path` exists by creating each segment. Infisical's
   * POST /api/v3/secrets/raw/{name} fails with 404 if any intermediate
   * folder is missing, so we walk the path and create what isn't there.
   * The folders API is not exposed via the SDK, so we use raw fetch with a
   * token minted from universal-auth login.
   */
  private async ensureFolderPath(path: string): Promise<void> {
    if (this.ensuredFolders.has(path)) return;
    // Build list of ancestor paths including this one, so we create top-down.
    const segments = path.split("/").filter(Boolean);
    const paths: string[] = ["/"];
    for (let i = 1; i <= segments.length; i++) {
      paths.push("/" + segments.slice(0, i).join("/"));
    }
    const bearer = await this.mintBearer();
    for (let i = 1; i < paths.length; i++) {
      const full = paths[i];
      if (this.ensuredFolders.has(full!)) continue;
      const parent = paths[i - 1];
      const name = segments[i - 1];
      const r = await fetch(`${this.cfg.url}/api/v1/folders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({
          // Infisical's folder API calls this field "workspaceId" even
          // though it's the same as the projectId used elsewhere.
          workspaceId: this.cfg.projectId,
          environment: this.cfg.environment,
          name,
          path: parent,
        }),
      });
      // 200/201 or 400 "already exists" both count as "ready".
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        if (!/already exist|duplicate/i.test(body)) {
          throw new Error(
            `folder create failed for ${String(full)} (${String(r.status)}): ${body.slice(0, 300)}`,
          );
        }
      }
      this.ensuredFolders.add(full!);
    }
  }

  /**
   * Log in with universal-auth and return the bearer JWT. Used for the
   * folder-create endpoint that the SDK doesn't wrap.
   */
  private async mintBearer(): Promise<string> {
    const r = await fetch(`${this.cfg.url}/api/v1/auth/universal-auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: this.cfg.clientId,
        clientSecret: this.cfg.clientSecret,
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`universal-auth login failed (${String(r.status)}): ${body.slice(0, 300)}`);
    }
    const j = (await r.json()) as { accessToken?: string; token?: string };
    const t = j.accessToken ?? j.token;
    if (!t) throw new Error("universal-auth login returned no token");
    return t;
  }

  private async getClient(): Promise<InfisicalSDK> {
    if (this.client) return this.client;
    if (this.authPromise) return this.authPromise;

    this.authPromise = (async () => {
      const sdk = new InfisicalSDK({ siteUrl: this.cfg.url });
      await sdk.auth().universalAuth.login({
        clientId: this.cfg.clientId,
        clientSecret: this.cfg.clientSecret,
      });
      this.client = sdk;
      return sdk;
    })();
    return this.authPromise;
  }

  async getSecret(path: string, name: string): Promise<string | null> {
    const sdk = await this.getClient();
    try {
      const res = await sdk.secrets().getSecret({
        projectId: this.cfg.projectId,
        environment: this.cfg.environment,
        secretPath: path,
        secretName: name,
      });
      return res.secretValue ?? null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getAllSecrets(path: string): Promise<Record<string, string>> {
    const sdk = await this.getClient();
    try {
      const res = await sdk.secrets().listSecrets({
        projectId: this.cfg.projectId,
        environment: this.cfg.environment,
        secretPath: path,
        expandSecretReferences: true,
      });
      const out: Record<string, string> = {};
      for (const s of res.secrets) {
        out[s.secretKey] = s.secretValue;
      }
      return out;
    } catch (err) {
      if (isNotFound(err)) return {};
      throw err;
    }
  }

  async setSecret(path: string, name: string, value: string): Promise<void> {
    const sdk = await this.getClient();
    // Ensure the parent folder path exists before writing — Infisical's
    // create/update endpoints 404 on missing intermediate folders.
    await this.ensureFolderPath(path);
    try {
      await sdk.secrets().updateSecret(name, {
        projectId: this.cfg.projectId,
        environment: this.cfg.environment,
        secretPath: path,
        secretValue: value,
      });
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await sdk.secrets().createSecret(name, {
        projectId: this.cfg.projectId,
        environment: this.cfg.environment,
        secretPath: path,
        secretValue: value,
      });
    }
  }

  async setSecrets(
    path: string,
    values: Record<string, string>,
  ): Promise<void> {
    await Promise.all(
      Object.entries(values).map(([name, value]) =>
        this.setSecret(path, name, value),
      ),
    );
  }

  async deleteSecret(path: string, name: string): Promise<void> {
    const sdk = await this.getClient();
    try {
      await sdk.secrets().deleteSecret(name, {
        projectId: this.cfg.projectId,
        environment: this.cfg.environment,
        secretPath: path,
      });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async deletePath(path: string): Promise<void> {
    const all = await this.getAllSecrets(path);
    await Promise.all(
      Object.keys(all).map((name) => this.deleteSecret(path, name)),
    );
  }
}

function isNotFound(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { status?: number; statusCode?: number; message?: string };
  if (anyErr.status === 404 || anyErr.statusCode === 404) return true;
  return /not found|404/i.test(anyErr.message ?? "");
}
