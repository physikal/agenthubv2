/**
 * Pure helpers for reading port info out of `docker compose ps --format json`
 * output. Live in their own module so unit tests don't pull in the SQLite
 * side effects that ../../db/index.js triggers at import time.
 */

interface ComposePsPublisher {
  URL?: string;
  TargetPort?: number;
  PublishedPort?: number;
  Protocol?: string;
}

export interface ComposePsService {
  Publishers?: ComposePsPublisher[];
}

/**
 * Parse `docker compose ps --format json` output. Modern Compose emits a
 * JSON array; older releases emit NDJSON (one object per line). Accept
 * both so we don't break on version skew.
 */
export function parseComposePs(stdout: string): ComposePsService[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as ComposePsService[];
  }
  const services: ComposePsService[] = [];
  for (const line of trimmed.split("\n")) {
    const clean = line.trim();
    if (!clean) continue;
    services.push(JSON.parse(clean) as ComposePsService);
  }
  return services;
}

/**
 * Pick the first TCP host port Docker actually published for this compose
 * project. Preference order: any-interface bindings (0.0.0.0 / ::) over
 * localhost-only (127.0.0.1 / ::1), since the latter isn't reachable from
 * the operator's browser. Returns null when no TCP port is published.
 */
export function firstPublishedTcpPort(services: ComposePsService[]): number | null {
  let external: number | null = null;
  let internal: number | null = null;
  for (const svc of services) {
    for (const pub of svc.Publishers ?? []) {
      if (pub.Protocol !== "tcp") continue;
      const port = pub.PublishedPort;
      if (!port || port <= 0) continue;
      const url = pub.URL ?? "";
      const isInternal = url === "127.0.0.1" || url === "::1";
      if (isInternal) internal ??= port;
      else external ??= port;
    }
  }
  return external ?? internal;
}
