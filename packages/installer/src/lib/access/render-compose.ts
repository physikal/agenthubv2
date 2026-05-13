import { dump as dumpYaml } from "js-yaml";
import type { AccessMode, PublicTlsMode } from "./types.js";

export interface RenderInput {
  accessMode: AccessMode;
  domain: string;
  publicTlsMode: PublicTlsMode | undefined;
  tlsEmail: string;
  dnsProvider?: string;
  dnsEnvVars?: Record<string, string>;
}

/**
 * Render Traefik's static config (compose/traefik.yml).
 *
 * - lan: just the `web` entrypoint on :80. No cert resolver. No websecure.
 * - public + public-alpn: web + websecure (with TLS), LE resolver via tlsChallenge.
 * - public + dns-01: web + websecure, LE resolver via dnsChallenge (provider).
 *
 * The file is mounted read-only into the traefik container at /etc/traefik/traefik.yml.
 * See compose/docker-compose.yml for the volume + command flags.
 */
export function renderTraefikStaticConfig(input: RenderInput): string {
  if (input.accessMode === "lan") {
    return dumpYaml({
      entryPoints: { web: { address: ":80" } },
      providers: {
        docker: { exposedByDefault: false, network: "agenthub" },
      },
      log: { level: "INFO" },
    });
  }

  // public mode
  if (!input.tlsEmail) {
    throw new Error(
      "public access mode requires AGENTHUB_TLS_EMAIL — Let's Encrypt needs " +
        "a contact email for expiry notifications.",
    );
  }
  if (input.publicTlsMode === "dns-01" && !input.dnsProvider) {
    throw new Error(
      "public + dns-01 requires dnsProvider (lego provider name, e.g. 'cloudflare').",
    );
  }

  const resolver =
    input.publicTlsMode === "dns-01"
      ? {
          acme: {
            email: input.tlsEmail,
            storage: "/letsencrypt/acme.json",
            dnsChallenge: { provider: input.dnsProvider! },
          },
        }
      : {
          acme: {
            email: input.tlsEmail,
            storage: "/letsencrypt/acme.json",
            tlsChallenge: {},
          },
        };

  return dumpYaml({
    entryPoints: {
      web: {
        address: ":80",
        http: {
          redirections: {
            entryPoint: { to: "websecure", scheme: "https", permanent: true },
          },
        },
      },
      websecure: { address: ":443" },
    },
    certificatesResolvers: { le: resolver },
    providers: {
      docker: { exposedByDefault: false, network: "agenthub" },
      file: { directory: "/etc/traefik/dynamic", watch: true },
    },
    log: { level: "INFO" },
  });
}

/**
 * Render the per-install override file (compose/traefik.override.yml).
 *
 * - lan: returns null. The base compose is sufficient; no override file.
 * - public (any sub-mode): attaches `certresolver=le` to agenthub-server.
 * - public + dns-01: also pushes DNS provider env vars onto the traefik
 *   service so lego can authenticate against the DNS API at runtime.
 *
 * Must NEVER emit `services.traefik.command:` (list-replace footgun, see PR #69).
 */
export function renderTraefikOverride(input: RenderInput): string | null {
  if (input.accessMode === "lan") return null;

  if (!input.tlsEmail) {
    throw new Error(
      "public access mode requires AGENTHUB_TLS_EMAIL — Let's Encrypt needs " +
        "a contact email for expiry notifications.",
    );
  }

  const services: Record<string, unknown> = {
    "agenthub-server": {
      labels: ["traefik.http.routers.agenthub.tls.certresolver=le"],
    },
  };

  if (input.publicTlsMode === "dns-01") {
    if (!input.dnsProvider) {
      throw new Error("public + dns-01 requires dnsProvider.");
    }
    services["traefik"] = {
      environment: input.dnsEnvVars ?? {},
    };
  }

  return dumpYaml({ services });
}

/**
 * Render the dynamic-config redirect middleware (compose/dynamic/redirect.yml).
 *
 * - lan: returns null. No HTTPS endpoint, nothing to redirect.
 * - public: emits the `redirectScheme` middleware. The base entryPoint config
 *   above already wires the redirect; this file makes the middleware available
 *   for any router that wants to attach it via label.
 */
export function renderRedirectDynamic(input: {
  accessMode: AccessMode;
}): string | null {
  if (input.accessMode === "lan") return null;
  return dumpYaml({
    http: {
      middlewares: {
        "redirect-to-https": {
          redirectScheme: { scheme: "https", permanent: true },
        },
      },
    },
  });
}
