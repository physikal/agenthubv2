/**
 * Process-wide mutex shared between the AgentHub binary update path
 * (`POST /api/admin/update`) and the image apply path
 * (`POST /api/admin/updates/image`). Both mutate the docker stack and
 * cannot safely run in parallel.
 *
 * In-memory only — fine because there's one agenthub-server process. If
 * we ever go multi-replica this needs to move to SQLite or Redis.
 */

let holder: string | null = null;

export function tryAcquireUpdateLock(by: string): boolean {
  if (holder !== null) return false;
  holder = by;
  return true;
}

export function releaseUpdateLock(): void {
  holder = null;
}

export function currentLockHolder(): string | null {
  return holder;
}
