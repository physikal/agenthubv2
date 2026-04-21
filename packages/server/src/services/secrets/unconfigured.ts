import {
  type SecretStore,
  SecretStoreNotConfiguredError,
} from "./types.js";

/**
 * No-op store for environments without Infisical (e.g., local dev without the
 * full compose bundle). Reads return null / empty; writes throw a clear error.
 * The server still boots; routes that absolutely need secrets surface
 * a 503 to the UI.
 */
export class UnconfiguredStore implements SecretStore {
  readonly configured = false;

  async getSecret(): Promise<string | null> {
    return Promise.resolve(null);
  }

  async getAllSecrets(): Promise<Record<string, string>> {
    return Promise.resolve({});
  }

  async setSecret(): Promise<void> {
    return Promise.reject(new SecretStoreNotConfiguredError());
  }

  async setSecrets(): Promise<void> {
    return Promise.reject(new SecretStoreNotConfiguredError());
  }

  async deleteSecret(): Promise<void> {
    return Promise.reject(new SecretStoreNotConfiguredError());
  }

  async deletePath(): Promise<void> {
    return Promise.reject(new SecretStoreNotConfiguredError());
  }
}
