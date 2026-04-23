import { getSecretStore } from "./index.js";

/**
 * Per-provider, which fields are secrets. Everything else is metadata that
 * stays in SQLite for easy querying/display. Add new providers in Phase 5.
 */
const SECRET_FIELDS: Record<string, readonly string[]> = {
  cloudflare: ["apiToken"],
  docker: ["sshPrivateKey"],
  digitalocean: ["apiToken"],
  "digitalocean-apps": ["apiToken"],
  dokploy: ["apiToken"],
  b2: ["b2AppKey"],
  github: ["pat"],
  "github-pages": [],
};

/**
 * Split an infra config into (safe metadata that goes to SQLite, secrets
 * that go to Infisical). Unknown providers treat every field as metadata
 * — safer default until Phase 5 defines their schemas.
 */
export function splitSecrets(
  provider: string,
  config: Record<string, unknown>,
): { metadata: Record<string, unknown>; secrets: Record<string, string> } {
  const secretKeys = SECRET_FIELDS[provider] ?? [];
  const metadata: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    if (secretKeys.includes(k) && typeof v === "string") {
      secrets[k] = v;
    } else {
      metadata[k] = v;
    }
  }
  return { metadata, secrets };
}

export function infraSecretPath(userId: string, infraId: string): string {
  return `/users/${userId}/infra/${infraId}`;
}

/**
 * Given metadata-only config + infraId, merge in secrets from Infisical so
 * the full config is available to drivers at runtime. Returns metadata alone
 * if the secret store isn't configured — routes that depend on secrets must
 * then surface a clear error.
 */
export async function resolveInfraConfig(
  userId: string,
  infraId: string,
  metadata: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const store = getSecretStore();
  if (!store.configured) return { ...metadata };
  const secrets = await store.getAllSecrets(infraSecretPath(userId, infraId));
  return { ...metadata, ...secrets };
}

export async function storeInfraSecrets(
  userId: string,
  infraId: string,
  secrets: Record<string, string>,
): Promise<void> {
  if (Object.keys(secrets).length === 0) return;
  const store = getSecretStore();
  await store.setSecrets(infraSecretPath(userId, infraId), secrets);
}

export async function deleteInfraSecrets(
  userId: string,
  infraId: string,
): Promise<void> {
  const store = getSecretStore();
  if (!store.configured) return;
  await store.deletePath(infraSecretPath(userId, infraId));
}
