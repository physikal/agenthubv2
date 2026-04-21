import { DockerHostingProvider } from "./docker-hosting.js";
import { DigitalOceanProvider } from "./digitalocean.js";
import { DokployHostingProvider } from "./dokploy-hosting.js";
import type { HostingProvider } from "./types.js";

export * from "./types.js";
export { DockerHostingProvider, DigitalOceanProvider, DokployHostingProvider };

const REGISTRY: Record<string, () => HostingProvider> = {
  docker: () => new DockerHostingProvider(),
  digitalocean: () => new DigitalOceanProvider(),
  dokploy: () => new DokployHostingProvider(),
};

export function getHostingProvider(name: string): HostingProvider | null {
  const factory = REGISTRY[name];
  return factory ? factory() : null;
}
