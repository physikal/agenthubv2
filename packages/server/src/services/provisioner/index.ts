import { DockerDriver } from "./docker.js";
import { DokployDriver } from "./dokploy.js";
import type { ProvisionerDriver, ProvisionerMode } from "./types.js";

export * from "./types.js";
export { DockerDriver, DokployDriver };

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} required for the selected provisioner mode`);
  return v;
}

export function createProvisioner(): ProvisionerDriver {
  const rawMode = process.env["PROVISIONER_MODE"] ?? "docker";
  const mode = rawMode as ProvisionerMode;

  switch (mode) {
    case "docker": {
      const opts: ConstructorParameters<typeof DockerDriver>[0] = {
        network: process.env["AGENTHUB_DOCKER_NETWORK"] ?? "agenthub",
      };
      if (process.env["DOCKER_HOST"]) opts.dockerHost = process.env["DOCKER_HOST"];
      return new DockerDriver(opts);
    }

    case "dokploy-remote":
      return new DokployDriver({
        baseUrl: requireEnv("DOKPLOY_URL"),
        apiToken: requireEnv("DOKPLOY_API_TOKEN"),
        projectId: requireEnv("DOKPLOY_PROJECT_ID"),
        environmentId: requireEnv("DOKPLOY_ENVIRONMENT_ID"),
      });

    default:
      throw new Error(
        `Unknown PROVISIONER_MODE: ${rawMode}. Expected docker | dokploy-remote`,
      );
  }
}
