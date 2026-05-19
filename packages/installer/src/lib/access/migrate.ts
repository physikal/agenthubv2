import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import {
  renderTraefikStaticConfig,
  renderRedirectDynamic,
} from "./render-compose.js";
import type { PublicTlsMode } from "./types.js";

export interface MigrateResult {
  action:
    | "noop-already-migrated"
    | "migrated-self-ca-to-lan"
    | "migrated-tls-to-public"
    | "migrated-localhost-to-lan";
  warnings: string[];
}

/**
 * Ensure AGENTHUB_INFISICAL_TLS and AGENTHUB_INFISICAL_URL are present in
 * .env based on the current access mode. Idempotent — overwrites with the
 * correct value, so a switch from lan→public (or vice versa) gets the right
 * Infisical wiring. Pre-Phase-X installs (before these vars existed) get
 * them backfilled here on the first `agenthub update` past this change.
 *
 * Host preference: AGENTHUB_PUBLIC_HOST (if set) > DOMAIN. Lan-mode installs
 * frequently have DOMAIN=localhost but users access via LAN IP — that LAN
 * IP must drive SITE_URL or Infisical's CORS will reject browser logins.
 */
function ensureInfisicalEnv(env: Map<string, string>): void {
  const accessMode = env.get("AGENTHUB_ACCESS_MODE") ?? "lan";
  const host =
    (env.get("AGENTHUB_PUBLIC_HOST") || "").trim() ||
    env.get("DOMAIN") ||
    "localhost";
  const scheme = accessMode === "public" ? "https" : "http";
  env.set("AGENTHUB_INFISICAL_TLS", accessMode === "public" ? "true" : "false");
  env.set("AGENTHUB_INFISICAL_URL", `${scheme}://${host}:8443`);
}

const HSTS_WARNING =
  "Browsers that visited the previous self-CA HTTPS install may be HSTS-pinned and refuse plain HTTP. " +
  "Operators must clear chrome://net-internals/#hsts (Chrome) or use 'Forget About This Site' (Firefox) " +
  "for this domain to reach the new lan-http install.";

function parseDotEnv(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    m.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return m;
}

function renderDotEnv(env: Map<string, string>): string {
  return Array.from(env.entries()).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

/**
 * Regenerate traefik.yml and dynamic/redirect.yml for a lan migration.
 * Deletes redirect.yml (no HTTPS on lan).
 */
function applyLanTraefikFiles(composeDir: string, domain: string): void {
  const traefikYaml = renderTraefikStaticConfig({
    accessMode: "lan",
    domain,
    publicTlsMode: undefined,
    tlsEmail: "",
  });
  writeFileSync(join(composeDir, "traefik.yml"), traefikYaml, { mode: 0o644 });

  const redirectPath = join(composeDir, "dynamic", "redirect.yml");
  if (existsSync(redirectPath)) unlinkSync(redirectPath);
}

/**
 * Regenerate traefik.yml and dynamic/redirect.yml for a public migration.
 */
function applyPublicTraefikFiles(
  composeDir: string,
  domain: string,
  publicTlsMode: PublicTlsMode,
  tlsEmail: string,
  dnsProvider: string | undefined,
): void {
  const traefikYaml = renderTraefikStaticConfig({
    accessMode: "public",
    domain,
    publicTlsMode,
    tlsEmail,
    ...(dnsProvider ? { dnsProvider } : {}),
  });
  writeFileSync(join(composeDir, "traefik.yml"), traefikYaml, { mode: 0o644 });

  const dynamicDir = join(composeDir, "dynamic");
  if (!existsSync(dynamicDir)) mkdirSync(dynamicDir, { recursive: true, mode: 0o755 });
  const redirectYaml = renderRedirectDynamic({ accessMode: "public" });
  // redirectYaml is always non-null for public mode
  writeFileSync(join(dynamicDir, "redirect.yml"), redirectYaml!, { mode: 0o644 });
}

export function migrateAccessConfig(composeDir: string): MigrateResult {
  const envPath = join(composeDir, ".env");
  if (!existsSync(envPath)) {
    return { action: "noop-already-migrated", warnings: [] };
  }
  const env = parseDotEnv(readFileSync(envPath, "utf8"));
  const warnings: string[] = [];

  // Already-migrated short-circuit. Still backfill the Infisical env vars
  // here — installs migrated before the AGENTHUB_INFISICAL_* additions
  // need them on disk before docker compose up can interpolate them.
  if (env.has("AGENTHUB_ACCESS_MODE")) {
    const hadInfisicalVars =
      env.has("AGENTHUB_INFISICAL_TLS") && env.has("AGENTHUB_INFISICAL_URL");
    if (!hadInfisicalVars) {
      ensureInfisicalEnv(env);
      writeFileSync(envPath, renderDotEnv(env));
      // Also regen traefik.yml so the new infisical entrypoint declaration
      // lands — without it, the docker-compose env-var change alone won't
      // unblock the router.
      const mode = env.get("AGENTHUB_ACCESS_MODE");
      if (mode === "lan") {
        applyLanTraefikFiles(composeDir, env.get("DOMAIN") ?? "localhost");
      } else if (mode === "public") {
        applyPublicTraefikFiles(
          composeDir,
          env.get("DOMAIN") ?? "localhost",
          (env.get("AGENTHUB_TLS_MODE") ?? "public-alpn") as PublicTlsMode,
          env.get("AGENTHUB_TLS_EMAIL") ?? env.get("TLS_EMAIL") ?? "",
          env.get("AGENTHUB_TLS_DNS_PROVIDER") ?? undefined,
        );
      }
    }
    return { action: "noop-already-migrated", warnings: [] };
  }

  const domain = env.get("DOMAIN") ?? "localhost";
  // Some pre-PR-#75 installs ran in self-CA mode without an explicit
  // AGENTHUB_TLS_MODE=self-ca line in .env — the mode was implied by the
  // presence of AGENTHUB_LAN_IP (self-CA only). Treat that as self-ca for
  // migration purposes; otherwise an "auto" default would route them to
  // the wrong (public) path.
  const oldMode =
    env.get("AGENTHUB_TLS_MODE") ??
    (env.has("AGENTHUB_LAN_IP") ? "self-ca" : "auto");

  // Localhost → lan
  if (domain === "localhost") {
    env.set("AGENTHUB_ACCESS_MODE", "lan");
    env.set("AGENTHUB_PUBLIC_URL", "http://localhost");
    env.delete("AGENTHUB_TLS_MODE");
    env.delete("AGENTHUB_LAN_IP");
    env.delete("COMPOSE_FILE");
    ensureInfisicalEnv(env);
    writeFileSync(envPath, renderDotEnv(env));
    applyLanTraefikFiles(composeDir, domain);
    return { action: "migrated-localhost-to-lan", warnings };
  }

  // self-ca → lan
  if (oldMode === "self-ca") {
    env.set("AGENTHUB_ACCESS_MODE", "lan");
    env.set("AGENTHUB_PUBLIC_URL", `http://${domain}`);
    env.delete("AGENTHUB_TLS_MODE");
    env.delete("AGENTHUB_LAN_IP");
    env.delete("COMPOSE_FILE");
    ensureInfisicalEnv(env);
    writeFileSync(envPath, renderDotEnv(env));
    // Delete the self-CA override file; the base compose is now sufficient.
    const overridePath = join(composeDir, "traefik.override.yml");
    if (existsSync(overridePath)) unlinkSync(overridePath);
    // Regen traefik.yml for lan (removes websecure + certificatesResolvers).
    applyLanTraefikFiles(composeDir, domain);
    warnings.push(HSTS_WARNING);
    return { action: "migrated-self-ca-to-lan", warnings };
  }

  // public-alpn / dns-01 → public + sub-mode
  if (oldMode === "public-alpn" || oldMode === "dns-01") {
    env.set("AGENTHUB_ACCESS_MODE", "public");
    env.set("AGENTHUB_PUBLIC_URL", `https://${domain}`);
    // Keep AGENTHUB_TLS_MODE as the sub-mode.
    ensureInfisicalEnv(env);
    writeFileSync(envPath, renderDotEnv(env));
    applyPublicTraefikFiles(
      composeDir,
      domain,
      oldMode as PublicTlsMode,
      env.get("AGENTHUB_TLS_EMAIL") ?? env.get("TLS_EMAIL") ?? "",
      oldMode === "dns-01" ? (env.get("AGENTHUB_TLS_DNS_PROVIDER") ?? undefined) : undefined,
    );
    return { action: "migrated-tls-to-public", warnings };
  }

  // auto on a real domain: pick public-alpn unless a DNS provider is set.
  if (oldMode === "auto") {
    const subMode: PublicTlsMode = env.has("AGENTHUB_TLS_DNS_PROVIDER") ? "dns-01" : "public-alpn";
    env.set("AGENTHUB_ACCESS_MODE", "public");
    env.set("AGENTHUB_PUBLIC_URL", `https://${domain}`);
    env.set("AGENTHUB_TLS_MODE", subMode);
    ensureInfisicalEnv(env);
    writeFileSync(envPath, renderDotEnv(env));
    applyPublicTraefikFiles(
      composeDir,
      domain,
      subMode,
      env.get("AGENTHUB_TLS_EMAIL") ?? env.get("TLS_EMAIL") ?? "",
      subMode === "dns-01" ? (env.get("AGENTHUB_TLS_DNS_PROVIDER") ?? undefined) : undefined,
    );
    return { action: "migrated-tls-to-public", warnings };
  }

  // Unknown mode: leave alone but warn. Defensive.
  warnings.push(`Unknown AGENTHUB_TLS_MODE='${oldMode}'; manual migration required.`);
  return { action: "noop-already-migrated", warnings };
}
