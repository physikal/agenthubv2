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
   *
   * Per the 2026-05-12 redesign, DNS provider env vars are placed on
   * the traefik service's `environment:` (which compose merges as a
   * dict — safe). The override no longer touches `services.traefik.
   * command:` or any other list-typed field, since those would clobber
   * the base compose. Cert resolver flags themselves live in
   * compose/traefik.yml (rendered separately).
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
 * Render the compose override for the resolved TLS mode.
 *
 * Per the 2026-05-12 redesign (see
 * docs/superpowers/specs/2026-05-12-tls-static-config-redesign.md), this
 * only emits compose constructs that merge SAFELY onto the base compose:
 *   - Service-level `environment:` (dict-merged): DNS provider tokens
 *     for dns-01 mode go to the traefik container's env so lego can
 *     read them at runtime.
 *   - Service-level `labels:` (list-appended): cert-resolver attachment
 *     to the agenthub-server router (public-alpn / dns-01).
 *   - Service-level `volumes:` (list-appended): self-ca only — mount
 *     the leaf-cert volume into Traefik.
 *   - New top-level services: self-ca only — init, renew, static
 *     containers.
 *
 * What it does NOT emit (and must never re-introduce):
 *   - `services.traefik.command:` — replaces the base command, killing
 *     `--configfile` and the ports we depend on.
 *   - Cert resolver / file provider config in env vars — Traefik's
 *     static-config precedence (file > CLI > env) means env vars get
 *     ignored once a configfile is loaded.
 *
 * All Traefik static config (entrypoints, providers, cert resolvers,
 * middlewares) goes through `renderTraefikConfig` → compose/traefik.yml
 * instead.
 *
 * Returns `null` for `none` (localhost) — no override file needed.
 */
export function renderTraefikOverride(input: RenderOverrideInput): string | null {
  if (input.mode === "none") return null;

  if (input.mode === "public-alpn") {
    if (!input.tlsEmail) {
      throw new Error(
        "public-alpn TLS mode requires AGENTHUB_TLS_EMAIL — Let's Encrypt " +
          "needs a contact email for expiry notifications.",
      );
    }
    // Only thing we need to add for public-alpn is the cert-resolver
    // label on the agenthub-server router; the cert resolver itself is
    // defined in compose/traefik.yml.
    return dumpYaml({
      services: {
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
          // DNS provider env vars (e.g. CF_DNS_API_TOKEN) — lego reads
          // these at runtime to talk to the DNS provider. dict-merged
          // with the base compose, so safe.
          environment: input.dnsEnvVars ?? {},
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
          // Mount the cert volume; depends_on the init container so the
          // cert files exist before Traefik starts. compose merges
          // `volumes:` by APPEND, so this adds to the base compose's
          // existing mounts rather than replacing them.
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
    `renderTraefikOverride: unrecognized mode '${input.mode as string}'.`,
  );
}
