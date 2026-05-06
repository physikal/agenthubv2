import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderTraefikOverride } from "./render-override.js";

export interface MigrateResult {
  action: "noop-already-migrated" | "noop-localhost" | "migrated";
  inferredMode?: "public-alpn";
  overridePath?: string;
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/**
 * Migrate an existing pre-Plan-1 install: if no traefik.override.yml exists,
 * generate one from the existing .env's DOMAIN + TLS_EMAIL (always inferring
 * public-alpn — the only mode that existed pre-migration). Idempotent on
 * already-migrated dirs.
 *
 * Called on the host before `docker compose up` during `agenthub update`.
 * Operates on real files because we need to rewrite .env in place.
 */
export function migrateTlsConfig(composeDir: string): MigrateResult {
  const overridePath = join(composeDir, "traefik.override.yml");
  const envPath = join(composeDir, ".env");

  if (existsSync(overridePath)) {
    return { action: "noop-already-migrated" };
  }
  if (!existsSync(envPath)) {
    throw new Error(
      `migrateTlsConfig: no .env at ${envPath}. Is composeDir correct?`,
    );
  }

  const envText = readFileSync(envPath, "utf8");
  const env = parseEnvFile(envText);
  const domain = env["DOMAIN"] ?? "localhost";

  if (domain === "localhost") {
    return { action: "noop-localhost" };
  }

  const tlsEmail = env["TLS_EMAIL"];
  if (!tlsEmail) {
    throw new Error(
      `migrateTlsConfig: domain=${domain} but TLS_EMAIL is missing from .env. ` +
        `Either add TLS_EMAIL to ${envPath} or set DOMAIN=localhost.`,
    );
  }

  const yaml = renderTraefikOverride({
    mode: "public-alpn",
    domain,
    tlsEmail,
  });
  if (!yaml) {
    throw new Error(
      "migrateTlsConfig: renderTraefikOverride returned null for non-localhost — bug",
    );
  }
  writeFileSync(overridePath, yaml, { mode: 0o644 });

  const composeFileLine = "COMPOSE_FILE=docker-compose.yml:traefik.override.yml";
  if (!envText.includes("COMPOSE_FILE=")) {
    const newline = envText.endsWith("\n") ? "" : "\n";
    writeFileSync(envPath, `${envText}${newline}${composeFileLine}\n`, {
      mode: 0o600,
    });
  }

  return {
    action: "migrated",
    inferredMode: "public-alpn",
    overridePath,
  };
}
