import { dump as dumpYaml } from "js-yaml";
import type { ResolvedTlsMode } from "./resolve-mode.js";

export interface RenderOverrideInput {
  mode: ResolvedTlsMode;
  domain: string;
  tlsEmail: string;
  /** Required for mode='dns-01'. e.g. 'cloudflare', 'route53'. */
  dnsProvider?: string;
  /**
   * Required for mode='dns-01'. Map of env var names → values. The values
   * should typically be `${VAR_NAME}` placeholders so docker compose
   * substitutes from the host's `.env` at run time, keeping the override
   * file free of literal secrets.
   */
  dnsEnvVars?: Record<string, string>;
  /** Required for mode='self-ca'. Comma-separated list of IPs for SAN. */
  lanIp?: string;
}

const NGINX_CONF = [
  "server {",
  "  listen 80;",
  "  location = /.well-known/agenthub-ca.crt {",
  "    alias /usr/share/nginx/html/.well-known/ca.crt;",
  "    add_header Content-Type application/x-x509-ca-cert;",
  "    add_header Content-Disposition 'attachment; filename=\"agenthub-ca.crt\"';",
  "  }",
  "  location /install/ca/ {",
  "    alias /usr/share/nginx/html/install/ca/;",
  "    index index.html;",
  "  }",
  "  location /install/ca {",
  "    return 301 /install/ca/;",
  "  }",
  "}",
].join("\n");

/**
 * Render the Traefik-specific compose override for the resolved TLS mode.
 *
 * Returns null for `none` (localhost): no override file needed, the base
 * compose's Traefik will serve its built-in default cert as fallback for
 * any Host without a cert resolver, which is the right behavior for local-
 * only access.
 *
 * Plans 2 and 3 extend this with the dns-01 and self-ca branches; this
 * plan only handles public-alpn (matching today's behavior post-refactor).
 */
export function renderTraefikOverride(input: RenderOverrideInput): string | null {
  if (input.mode === "none") return null;

  // Why env vars instead of `command:` flags: docker-compose's override merge
  // REPLACES list-typed fields (`command:` is a list) but MERGES dicts (env
  // vars). Putting Traefik flags in `command:` clobbers the base compose's
  // entrypoints / providers.docker / redirect flags. Traefik's TRAEFIK_*-
  // prefixed env vars are first-class equivalents to every CLI flag (per
  // doc.traefik.io/traefik/reference/static-configuration/env), and they
  // merge cleanly without losing the base config.
  if (input.mode === "public-alpn") {
    if (!input.tlsEmail) {
      throw new Error(
        "public-alpn TLS mode requires AGENTHUB_TLS_EMAIL — Let's Encrypt " +
          "needs a contact email for expiry notifications.",
      );
    }
    return dumpYaml({
      services: {
        traefik: {
          environment: {
            TRAEFIK_CERTIFICATESRESOLVERS_LE_ACME_TLSCHALLENGE: "true",
            TRAEFIK_CERTIFICATESRESOLVERS_LE_ACME_EMAIL: input.tlsEmail,
            TRAEFIK_CERTIFICATESRESOLVERS_LE_ACME_STORAGE:
              "/letsencrypt/acme.json",
          },
        },
        "agenthub-server": {
          labels: ["traefik.http.routers.agenthub.tls.certresolver=le"],
        },
      },
    });
  }

  if (input.mode === "dns-01") {
    if (!input.tlsEmail) {
      throw new Error(
        "dns-01 TLS mode requires AGENTHUB_TLS_EMAIL — Let's Encrypt " +
          "needs a contact email for expiry notifications.",
      );
    }
    if (!input.dnsProvider) {
      throw new Error(
        "dns-01 TLS mode requires dnsProvider (lego provider name).",
      );
    }
    return dumpYaml({
      services: {
        traefik: {
          environment: {
            TRAEFIK_CERTIFICATESRESOLVERS_LE_ACME_DNSCHALLENGE: "true",
            TRAEFIK_CERTIFICATESRESOLVERS_LE_ACME_DNSCHALLENGE_PROVIDER:
              input.dnsProvider,
            TRAEFIK_CERTIFICATESRESOLVERS_LE_ACME_EMAIL: input.tlsEmail,
            TRAEFIK_CERTIFICATESRESOLVERS_LE_ACME_STORAGE:
              "/letsencrypt/acme.json",
            ...(input.dnsEnvVars ?? {}),
          },
        },
        "agenthub-server": {
          labels: ["traefik.http.routers.agenthub.tls.certresolver=le"],
        },
      },
    });
  }

  if (input.mode === "self-ca") {
    if (!input.lanIp) {
      throw new Error(
        "self-ca TLS mode requires lanIp (host LAN IP for cert SAN).",
      );
    }
    return dumpYaml({
      services: {
        traefik: {
          environment: {
            TRAEFIK_PROVIDERS_FILE_DIRECTORY: "/etc/traefik/dynamic",
          },
          volumes: ["traefik-self-ca:/etc/traefik/dynamic:ro"],
          depends_on: {
            "traefik-self-ca-init": {
              condition: "service_completed_successfully",
            },
          },
        },
        "traefik-self-ca-init": {
          image: "alpine:3.20",
          restart: "no",
          environment: {
            DOMAIN: input.domain,
            LAN_IP: input.lanIp,
          },
          command: ["sh", "/init.sh"],
          volumes: [
            "traefik-self-ca:/out",
            "../scripts/self-ca-init.sh:/init.sh:ro",
          ],
        },
        "traefik-self-ca-renew": {
          image: "alpine:3.20",
          restart: "unless-stopped",
          depends_on: {
            "traefik-self-ca-init": {
              condition: "service_completed_successfully",
            },
          },
          environment: {
            DOMAIN: input.domain,
            LAN_IP: input.lanIp,
          },
          command: ["sh", "/renew.sh"],
          volumes: [
            "traefik-self-ca:/out",
            "../scripts/self-ca-init.sh:/init.sh:ro",
            "../scripts/self-ca-renew.sh:/renew.sh:ro",
          ],
        },
        "agenthub-static": {
          image: "nginx:alpine",
          restart: "unless-stopped",
          depends_on: {
            "traefik-self-ca-init": {
              condition: "service_completed_successfully",
            },
          },
          volumes: [
            "traefik-self-ca:/usr/share/nginx/html/.well-known:ro",
            "../compose/static/install-ca:/usr/share/nginx/html/install/ca:ro",
          ],
          configs: [
            {
              source: "agenthub-static-nginx",
              target: "/etc/nginx/conf.d/default.conf",
            },
          ],
          labels: [
            "traefik.enable=true",
            "traefik.http.routers.agenthub-ca.rule=Path(`/.well-known/agenthub-ca.crt`)",
            "traefik.http.routers.agenthub-ca.entrypoints=web",
            "traefik.http.routers.agenthub-ca.service=agenthub-static",
            "traefik.http.routers.install-ca.rule=PathPrefix(`/install/ca`)",
            "traefik.http.routers.install-ca.entrypoints=web",
            "traefik.http.routers.install-ca.service=agenthub-static",
            "traefik.http.services.agenthub-static.loadbalancer.server.port=80",
          ],
        },
      },
      configs: {
        "agenthub-static-nginx": {
          content: NGINX_CONF,
        },
      },
      volumes: {
        "traefik-self-ca": {},
      },
    });
  }

  throw new Error(
    `renderTraefikOverride: unrecognized mode '${input.mode}'.`,
  );
}
