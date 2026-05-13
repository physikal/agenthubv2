import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { renderTraefikConfig } from "./render-traefik-config.js";
import { renderTraefikOverride } from "./render-override.js";
import { resolveTlsMode } from "./resolve-mode.js";
import type { TlsMode } from "../config.js";

export interface MigrateResult {
  action:
    | "noop-already-migrated"
    | "migrated-new-shape"
    | "migrated-from-old-shape";
  inferredMode?: "public-alpn" | "dns-01" | "self-ca" | "none";
  configPath?: string;
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
 * Detect whether an existing `traefik.override.yml` is the OLD shape
 * (carries `services.traefik.command` or `services.traefik.environment`)
 * — both of which break in production per the 2026-05-12 redesign.
 *
 * Doesn't parse YAML; a substring match is enough since these keys are
 * unambiguous and we only care about a yes/no signal.
 */
function isOldShapeOverride(yamlText: string): boolean {
  // Look for the traefik service block specifically. A pretty crude
  // heuristic but the override file is small and machine-generated, so
  // false positives are vanishingly unlikely.
  const traefikIdx = yamlText.indexOf("\n  traefik:");
  if (traefikIdx === -1) return false;
  // Slice from `  traefik:` to the next top-level service block (line
  // starting with two spaces + non-space — i.e. the next `  service-name:`).
  const after = yamlText.slice(traefikIdx + 1);
  const nextBlock = after.search(/\n  [a-zA-Z][a-zA-Z0-9_-]*:/);
  const traefikSection = nextBlock === -1 ? after : after.slice(0, nextBlock);
  // Old shapes both put either `command:` or non-empty `environment:` here.
  if (/\n    command:/.test(traefikSection)) return true;
  if (/\n    environment:\n      TRAEFIK_/.test(traefikSection)) return true;
  return false;
}

/**
 * Migrate an existing install to the static-config shape introduced by
 * the 2026-05-12 redesign. Detects + handles three states:
 *
 *   1. Brand-new install (no traefik.yml, no override) → render both
 *      based on .env (`migrated-new-shape`).
 *   2. Old install with a `traefik.override.yml` carrying
 *      `services.traefik.command` or `environment.TRAEFIK_*` (PR #62 or
 *      PR #69 shape) → rewrite both files in the new shape
 *      (`migrated-from-old-shape`).
 *   3. Already-migrated (traefik.yml exists, override is in new shape)
 *      → no-op.
 *
 * Called on the host before `docker compose up` during `agenthub update`.
 * Idempotent.
 */
export function migrateTlsConfig(composeDir: string): MigrateResult {
  const configPath = join(composeDir, "traefik.yml");
  const overridePath = join(composeDir, "traefik.override.yml");
  const envPath = join(composeDir, ".env");

  if (!existsSync(envPath)) {
    throw new Error(
      `migrateTlsConfig: no .env at ${envPath}. Is composeDir correct?`,
    );
  }

  const envText = readFileSync(envPath, "utf8");
  const env = parseEnvFile(envText);
  const domain = env["DOMAIN"] ?? "localhost";

  // Idempotency: traefik.yml present + (no override OR override in new
  // shape) means we've already migrated; no work to do.
  if (existsSync(configPath)) {
    if (
      !existsSync(overridePath) ||
      !isOldShapeOverride(readFileSync(overridePath, "utf8"))
    ) {
      return { action: "noop-already-migrated" };
    }
  }

  const fromOldShape =
    existsSync(overridePath) &&
    isOldShapeOverride(readFileSync(overridePath, "utf8"));

  // Resolve the mode using the same logic as install/reconfigure. .env
  // doesn't always carry AGENTHUB_TLS_MODE (older installs predate it);
  // resolveTlsMode handles missing/empty by inferring from the DNS
  // provider env var, then falling back to public-alpn.
  const declaredMode = (env["AGENTHUB_TLS_MODE"] ?? "auto") as TlsMode;
  const resolved = resolveTlsMode(declaredMode, domain, env);

  const tlsEmail = env["TLS_EMAIL"] ?? "";
  if (resolved !== "none" && resolved !== "self-ca" && !tlsEmail) {
    throw new Error(
      `migrateTlsConfig: domain=${domain} mode=${resolved} but TLS_EMAIL is missing from .env. ` +
        `Either add TLS_EMAIL to ${envPath}, set DOMAIN=localhost, or pick AGENTHUB_TLS_MODE=self-ca.`,
    );
  }

  // Always render the static config (even for none/localhost — the base
  // compose's traefik mount target needs to exist).
  const traefikYaml = renderTraefikConfig({
    mode: resolved,
    domain,
    tlsEmail,
    dnsProvider: env["AGENTHUB_TLS_DNS_PROVIDER"] ?? "",
  });
  writeFileSync(configPath, traefikYaml, { mode: 0o644 });

  // Render the override (or remove a stale one for none/localhost).
  if (resolved === "none") {
    if (existsSync(overridePath)) unlinkSync(overridePath);
  } else {
    const dnsEnvVars: Record<string, string> = {};
    if (env["AGENTHUB_CLOUDFLARE_API_TOKEN"]) {
      dnsEnvVars["CF_DNS_API_TOKEN"] = "${AGENTHUB_CLOUDFLARE_API_TOKEN}";
    }
    const dnsProvider = env["AGENTHUB_TLS_DNS_PROVIDER"];
    const yaml = renderTraefikOverride({
      mode: resolved,
      domain,
      tlsEmail,
      ...(dnsProvider ? { dnsProvider } : {}),
      dnsEnvVars,
      lanIp: env["AGENTHUB_LAN_IP"] ?? "",
    });
    if (yaml) writeFileSync(overridePath, yaml, { mode: 0o644 });
  }

  // Ensure COMPOSE_FILE references the override when one exists.
  if (resolved !== "none" && !envText.includes("COMPOSE_FILE=")) {
    const newline = envText.endsWith("\n") ? "" : "\n";
    writeFileSync(
      envPath,
      `${envText}${newline}COMPOSE_FILE=docker-compose.yml:traefik.override.yml\n`,
      { mode: 0o600 },
    );
  }

  const result: MigrateResult = {
    action: fromOldShape ? "migrated-from-old-shape" : "migrated-new-shape",
    inferredMode: resolved,
    configPath,
  };
  if (resolved !== "none") result.overridePath = overridePath;
  return result;
}
