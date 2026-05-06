import { dump as dumpYaml } from "js-yaml";
import type { ResolvedTlsMode } from "./resolve-mode.js";

export interface RenderOverrideInput {
  mode: ResolvedTlsMode;
  domain: string;
  tlsEmail: string;
}

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
          command: [
            "--certificatesresolvers.le.acme.tlschallenge=true",
            `--certificatesresolvers.le.acme.email=${input.tlsEmail}`,
            "--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json",
          ],
        },
        "agenthub-server": {
          labels: ["traefik.http.routers.agenthub.tls.certresolver=le"],
        },
      },
    });
  }

  throw new Error(
    `renderTraefikOverride: mode '${input.mode}' is not implemented in this plan; ` +
      "Plan 2 (dns-01) and Plan 3 (self-ca) add the remaining branches.",
  );
}
