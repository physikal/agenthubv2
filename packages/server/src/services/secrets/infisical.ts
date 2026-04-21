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

  constructor(cfg: InfisicalConfig) {
    this.cfg = cfg;
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
