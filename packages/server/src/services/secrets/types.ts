/**
 * Provider-agnostic secret storage.
 *
 * Paths use forward slashes. The convention we follow across routes:
 *   /users/{userId}/b2           → Backblaze backup credentials
 *   /users/{userId}/infra/{infraId}  → a single infrastructure config's secrets
 *
 * A store is in one of two states:
 *   - `configured = true`  → reads and writes go to Infisical (or equivalent).
 *   - `configured = false` → reads return null, writes throw. The server still
 *     boots; routes that need secrets return a clear error to the UI. This is
 *     deliberate: half-configured Infisical is worse than "not configured"
 *     because it silently loses data.
 */
export interface SecretStore {
  readonly configured: boolean;

  getSecret(path: string, name: string): Promise<string | null>;
  getAllSecrets(path: string): Promise<Record<string, string>>;
  setSecret(path: string, name: string, value: string): Promise<void>;
  setSecrets(path: string, values: Record<string, string>): Promise<void>;
  deleteSecret(path: string, name: string): Promise<void>;
  deletePath(path: string): Promise<void>;
}

export class SecretStoreNotConfiguredError extends Error {
  constructor() {
    super(
      "Secret store not configured. Set INFISICAL_URL, " +
        "INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET, INFISICAL_PROJECT_ID, " +
        "and INFISICAL_ENVIRONMENT (defaults to 'prod').",
    );
    this.name = "SecretStoreNotConfiguredError";
  }
}
