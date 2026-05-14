import type { Conflict, ConflictReport } from "./types.js";

export interface ConflictInputs {
  userCount: number;
  secretCount: number;
  activeSessionCount: number;
  currentEnvEncryptionKey: string;
  bundleEnvEncryptionKey: string;
}

export function computeConflicts(state: ConflictInputs): ConflictReport {
  const conflicts: Conflict[] = [];

  if (state.userCount > 0) {
    conflicts.push({
      kind: "users-exist",
      detail: `current install has ${state.userCount} user(s); restore would overwrite them`,
    });
  }
  if (state.secretCount > 0) {
    conflicts.push({
      kind: "secrets-exist",
      detail: `current Infisical has ${state.secretCount} secret(s); restore would overwrite them`,
    });
  }
  if (state.activeSessionCount > 0) {
    conflicts.push({
      kind: "active-sessions",
      detail: `${state.activeSessionCount} workspace session(s) are running; end them before restore`,
    });
  }
  if (
    state.secretCount > 0 &&
    state.currentEnvEncryptionKey !== state.bundleEnvEncryptionKey
  ) {
    conflicts.push({
      kind: "encryption-key-mismatch",
      detail:
        "INFISICAL_ENCRYPTION_KEY in bundle differs from current install. " +
        "Restoring would leave existing Infisical secrets undecryptable. " +
        "Use --force only if you're certain.",
    });
  }

  return { ok: conflicts.length === 0, conflicts };
}
