import { getSecretStore } from "./index.js";

/**
 * Per-user secrets that get injected into the workspace shell as env vars
 * at session-active time. Stored in Infisical under `/users/{userId}/workspace-env/`.
 *
 * Why a dedicated path:
 * - Separates user-customizable workspace env from the structured provider
 *   integrations under `/users/{userId}/infra/{infraId}` (which the server
 *   reads for its own deploy/backup/DNS automation, never inject into
 *   workspaces).
 * - Lets the injection code list-and-inject everything under one path
 *   without needing to know names ahead of time.
 *
 * Sessions only see the env vars present at SessionManager start time.
 * Changes made after a session is active don't propagate — operator must
 * restart the session.
 */

const WORKSPACE_ENV_PATH = (userId: string): string =>
  `/users/${userId}/workspace-env`;

const POSIX_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Names AgentHub itself sets on every session. We reject these to avoid
 * giving the user a footgun (e.g., overriding ANTHROPIC_API_KEY would
 * shadow their Integrations setting and confuse the failure mode).
 * Keep in sync with what session-manager.ts and the workspace image set.
 */
const RESERVED_NAMES = new Set<string>([
  "AGENT_TOKEN",
  "PORT",
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_BASE_URL",
  "GITHUB_ACCOUNT_LOGIN",
]);

/** Infisical's per-secret value limit. */
const MAX_VALUE_BYTES = 32 * 1024;

export interface NameValidationError {
  reason: "format" | "reserved" | "too-long";
  message: string;
}

/**
 * Returns an error explaining why `name` isn't acceptable, or null if it is.
 * Names must be POSIX env-var-safe and not collide with anything AgentHub
 * itself sets. The value cap is Infisical's API limit.
 */
export function validateName(name: string): NameValidationError | null {
  if (!POSIX_ENV_NAME.test(name)) {
    return {
      reason: "format",
      message:
        "Name must match /^[A-Z_][A-Z0-9_]*$/ (uppercase letters, digits, underscores; can't start with a digit).",
    };
  }
  if (RESERVED_NAMES.has(name)) {
    return {
      reason: "reserved",
      message: `Name '${name}' is reserved — AgentHub sets it on every session.`,
    };
  }
  return null;
}

export function validateValue(value: string): NameValidationError | null {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_VALUE_BYTES) {
    return {
      reason: "too-long",
      message: `Value is ${String(bytes)} bytes; max is ${String(MAX_VALUE_BYTES)}.`,
    };
  }
  return null;
}

/**
 * List the names of workspace secrets the user has set. Values are NOT
 * returned — the UI displays names only.
 */
export async function listWorkspaceEnvNames(userId: string): Promise<string[]> {
  const store = getSecretStore();
  if (!store.configured) return [];
  const all = await store.getAllSecrets(WORKSPACE_ENV_PATH(userId));
  return Object.keys(all).sort();
}

/**
 * Upsert one workspace env var. Throws if name/value validation fails or
 * the secret store isn't configured.
 */
export async function setWorkspaceEnv(
  userId: string,
  name: string,
  value: string,
): Promise<void> {
  const nameErr = validateName(name);
  if (nameErr) throw new Error(nameErr.message);
  const valueErr = validateValue(value);
  if (valueErr) throw new Error(valueErr.message);
  const store = getSecretStore();
  await store.setSecret(WORKSPACE_ENV_PATH(userId), name, value);
}

export async function deleteWorkspaceEnv(
  userId: string,
  name: string,
): Promise<void> {
  // Defensive: reject deletion of names with bad format too — protects
  // against a path-traversal-ish attempt via the route.
  const nameErr = validateName(name);
  if (nameErr && nameErr.reason !== "reserved") throw new Error(nameErr.message);
  const store = getSecretStore();
  if (!store.configured) return;
  await store.deleteSecret(WORKSPACE_ENV_PATH(userId), name);
}

/**
 * Fetch all workspace env vars for injection at session start. Reserved
 * names are filtered out as a belt-and-suspenders check — they should
 * never be storable in the first place, but if some other path put one
 * there we still ignore it instead of letting it override the system value.
 */
export async function resolveWorkspaceEnv(
  userId: string,
): Promise<Record<string, string>> {
  const store = getSecretStore();
  if (!store.configured) return {};
  const all = await store.getAllSecrets(WORKSPACE_ENV_PATH(userId));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (RESERVED_NAMES.has(k)) continue;
    out[k] = v;
  }
  return out;
}
