import { dump as dumpYaml } from "js-yaml";
import type { ResolvedTlsMode } from "./resolve-mode.js";

export interface RenderTraefikConfigInput {
  mode: ResolvedTlsMode;
  domain: string;
  tlsEmail: string;
  /** Required for mode='dns-01'. e.g. 'cloudflare', 'route53'. */
  dnsProvider?: string;
}

/**
 * Render the full Traefik static-config YAML for the resolved TLS mode.
 *
 * This is the single source of truth for Traefik's static configuration —
 * mounted into the Traefik container as `/etc/traefik/traefik.yml` and
 * loaded via `--configfile=`. Replaces the earlier compose-override
 * approach (which couldn't merge cleanly: see the 2026-05-12
 * static-config redesign spec).
 *
 * Always returns a YAML string (never null) — even `none`/localhost gets
 * the base config (no cert resolver, no file provider). That keeps the
 * base compose's command identical across modes (`--configfile=…`).
 *
 * The HTTP→HTTPS redirect is defined as a router-level middleware
 * (`redirect-to-https@file`) so individual routers can opt in or out.
 * The base compose's per-service labels attach the middleware to the
 * agenthub-server router; the self-CA mode's `agenthub-static`
 * container OMITS the middleware on its `/install/ca` and
 * `/.well-known/agenthub-ca.crt` routers so the CA-trust path stays
 * accessible on plain HTTP (chicken-and-egg).
 */
export function renderTraefikConfig(input: RenderTraefikConfigInput): string {
  // Static config only. Routers / middlewares / services are dynamic
  // config and live in compose/dynamic/redirect.yml (rendered separately
  // by renderTraefikDynamicConfig), loaded via the file provider.
  const config: Record<string, unknown> = {
    log: { level: "INFO" },
    entryPoints: {
      web: { address: ":80" },
      websecure: { address: ":443" },
      infisical: { address: ":8443" },
    },
    api: { dashboard: false },
    providers: {
      docker: { exposedByDefault: false },
      // File provider always enabled — points at the dynamic config
      // directory that contains the http→https redirect router (all
      // modes) and (self-ca only) the self-signed leaf cert config.
      file: { directory: "/etc/traefik/dynamic", watch: true },
    },
  };

  if (input.mode === "public-alpn") {
    if (!input.tlsEmail) {
      throw new Error(
        "public-alpn TLS mode requires AGENTHUB_TLS_EMAIL — Let's Encrypt " +
          "needs a contact email for expiry notifications.",
      );
    }
    config["certificatesResolvers"] = {
      le: {
        acme: {
          tlsChallenge: {},
          email: input.tlsEmail,
          storage: "/letsencrypt/acme.json",
        },
      },
    };
  } else if (input.mode === "dns-01") {
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
    config["certificatesResolvers"] = {
      le: {
        acme: {
          dnsChallenge: { provider: input.dnsProvider },
          email: input.tlsEmail,
          storage: "/letsencrypt/acme.json",
        },
      },
    };
  } else if (input.mode === "self-ca") {
    // File provider already enabled above for the redirect dynamic
    // config; no extra static-config additions needed for self-CA.
    // The leaf cert is added to the same dynamic dir by the init
    // container (via tls.certificates in dynamic/self-ca.yml).
  } else if (input.mode === "none") {
    // localhost: just the base config, no cert resolver, no file provider.
    // Traefik will serve its built-in default cert as fallback for any
    // Host without a resolver — exactly the right behavior for local-only.
  } else {
    throw new Error(
      `renderTraefikConfig: unrecognized mode '${String(input.mode)}'.`,
    );
  }

  return dumpYaml(config);
}
