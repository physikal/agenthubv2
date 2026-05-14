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

  // Already-migrated short-circuit
  if (env.has("AGENTHUB_ACCESS_MODE")) {
    return { action: "noop-already-migrated", warnings: [] };
  }

  const domain = env.get("DOMAIN") ?? "localhost";
  const oldMode = env.get("AGENTHUB_TLS_MODE") ?? "auto";

  // Localhost → lan
  if (domain === "localhost") {
    env.set("AGENTHUB_ACCESS_MODE", "lan");
    env.set("AGENTHUB_PUBLIC_URL", "http://localhost");
    env.delete("AGENTHUB_TLS_MODE");
    env.delete("COMPOSE_FILE");
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
