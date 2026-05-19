import type { ImageCatalogEntry, ImageKey } from "./types.js";

export const CATALOG: Record<ImageKey, ImageCatalogEntry> = {
  traefik: {
    key: "traefik",
    displayName: "Traefik",
    repo: "traefik",
    composeService: "traefik",
    envVar: "TRAEFIK_IMAGE",
    defaultPin: "traefik:v3.6",
    disruption:
      "Restarts the reverse proxy. New HTTP requests fail for 1-2s while Traefik reloads.",
  },
  postgres: {
    key: "postgres",
    displayName: "Postgres (Infisical)",
    repo: "postgres",
    composeService: "infisical-postgres",
    envVar: "POSTGRES_IMAGE",
    defaultPin: "postgres:16-alpine",
    disruption:
      "Restarts Infisical's database. Infisical fails secret reads for 5-15s while postgres restarts; agenthub-server may briefly fail to resolve user secrets.",
  },
  redis: {
    key: "redis",
    displayName: "Redis (Infisical)",
    repo: "redis",
    composeService: "infisical-redis",
    envVar: "REDIS_IMAGE",
    defaultPin: "redis:7-alpine",
    disruption:
      "Restarts Infisical's cache. Infisical session lookups briefly fail; cached state is lost.",
  },
  infisical: {
    key: "infisical",
    displayName: "Infisical",
    repo: "infisical/infisical",
    composeService: "infisical",
    envVar: "INFISICAL_IMAGE",
    defaultPin: "infisical/infisical:latest-postgres",
    disruption:
      "Restarts the Infisical server. Secret reads fail for ~10s; existing sessions remain.",
  },
};

export const CATALOG_KEYS: readonly ImageKey[] = [
  "traefik",
  "postgres",
  "redis",
  "infisical",
];
