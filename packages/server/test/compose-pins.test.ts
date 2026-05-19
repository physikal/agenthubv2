import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const composePath = resolve(here, "../../../compose/docker-compose.yml");

interface ExpectedPin {
  readonly varName: string;
  readonly defaultValue: string;
}

const PINS: readonly ExpectedPin[] = [
  { varName: "TRAEFIK_IMAGE", defaultValue: "traefik:v3.6" },
  { varName: "POSTGRES_IMAGE", defaultValue: "postgres:16-alpine" },
  { varName: "REDIS_IMAGE", defaultValue: "redis:7-alpine" },
  { varName: "INFISICAL_IMAGE", defaultValue: "infisical/infisical:latest-postgres" },
];

describe("compose pin env-overrides", () => {
  it("every pinned image uses ${VAR:-default} interpolation", () => {
    const compose = readFileSync(composePath, "utf8");
    for (const pin of PINS) {
      const needle = `image: \${${pin.varName}:-${pin.defaultValue}}`;
      expect(compose).toContain(needle);
    }
  });

  it("defaults match the catalog's defaultPin values", async () => {
    const { CATALOG } = await import("../src/services/images/catalog.js");
    expect(CATALOG.traefik.defaultPin).toBe("traefik:v3.6");
    expect(CATALOG.postgres.defaultPin).toBe("postgres:16-alpine");
    expect(CATALOG.redis.defaultPin).toBe("redis:7-alpine");
    expect(CATALOG.infisical.defaultPin).toBe("infisical/infisical:latest-postgres");
  });
});
