import { InfisicalStore } from "./infisical.js";
import { UnconfiguredStore } from "./unconfigured.js";
import type { SecretStore } from "./types.js";

export * from "./types.js";
export { InfisicalStore, UnconfiguredStore };

let singleton: SecretStore | null = null;

export function getSecretStore(): SecretStore {
  if (singleton) return singleton;

  const url = process.env["INFISICAL_URL"];
  const clientId = process.env["INFISICAL_CLIENT_ID"];
  const clientSecret = process.env["INFISICAL_CLIENT_SECRET"];
  const projectId = process.env["INFISICAL_PROJECT_ID"];
  const environment = process.env["INFISICAL_ENVIRONMENT"] ?? "prod";

  if (url && clientId && clientSecret && projectId) {
    console.log(`[secrets] using Infisical at ${url} (project ${projectId}, env ${environment})`);
    singleton = new InfisicalStore({
      url,
      clientId,
      clientSecret,
      projectId,
      environment,
    });
  } else {
    console.warn(
      "[secrets] INFISICAL_* env vars not set — SecretStore disabled. " +
        "Provider credential storage will return 503 until Infisical is configured.",
    );
    singleton = new UnconfiguredStore();
  }

  return singleton;
}
