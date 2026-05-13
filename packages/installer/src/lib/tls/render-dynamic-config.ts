import { dump as dumpYaml } from "js-yaml";

/**
 * Render the dynamic Traefik config containing the http→https redirect
 * router + middleware. Loaded by Traefik's file provider from
 * /etc/traefik/dynamic/redirect.yml. Emitted for ALL TLS modes (incl.
 * localhost) — the redirect is the right behavior everywhere we have
 * a websecure entrypoint, and the docker-labeled `agenthub-static`
 * routers (self-CA only) override on `/install/ca` and `/.well-known/
 * agenthub-ca.crt` via Traefik's default rule-length-based priority,
 * which is significantly higher than this catch-all router's explicit
 * priority of 1.
 *
 * Bug #10 fix from the post-PR-#62 audit: previously the redirect
 * was at entrypoint level (always-on, no per-router bypass), which
 * made /install/ca unreachable on plain HTTP — defeating the whole
 * purpose of the install-CA page (you can't trust a self-signed CA
 * via HTTPS until you've already trusted it).
 */
export function renderTraefikDynamicConfig(): string {
  return dumpYaml({
    http: {
      middlewares: {
        "redirect-to-https": {
          redirectScheme: { scheme: "https", permanent: true },
        },
      },
      routers: {
        "redirect-all-to-https": {
          // Plain Go regex — matches any non-empty host. In v2 this
          // would have been `{any:.+}` (named capture); v3 dropped the
          // named-capture syntax entirely. Tested in v3.6.17.
          rule: "HostRegexp(`.+`)",
          entryPoints: ["web"],
          middlewares: ["redirect-to-https"],
          // Explicit priority lower than docker-labeled routers'
          // implicit (rule-length-based) priorities so they win when
          // a request matches both.
          priority: 1,
          service: "redirect-stub",
        },
      },
      // Stub: the redirect middleware short-circuits with a 301
      // before the request ever reaches a backend. Traefik still
      // requires a service on every router, so this points at a
      // deliberately-unreachable address.
      services: {
        "redirect-stub": {
          loadBalancer: {
            servers: [{ url: "http://127.0.0.1:65535" }],
          },
        },
      },
    },
  });
}
