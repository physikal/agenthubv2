export type ImageKey = "traefik" | "postgres" | "redis" | "infisical";

export interface ImageCatalogEntry {
  readonly key: ImageKey;
  readonly displayName: string;
  // Docker Hub repository slug. Single-segment for official images
  // ("traefik"), two-segment for org images ("infisical/infisical").
  readonly repo: string;
  // The compose service name (`docker compose ... <service>`).
  // Note: postgres/redis services are namespaced `infisical-postgres` /
  // `infisical-redis` because they're Infisical's data layer.
  readonly composeService: string;
  // The env var that overrides the pin in compose.yml.
  readonly envVar: string;
  // The default image:tag if no env override is set. MUST match the
  // value baked into compose/docker-compose.yml after Task 6 lands.
  readonly defaultPin: string;
  // Human-readable description of what happens when this service is
  // recreated. Shown in the confirmation modal.
  readonly disruption: string;
}
