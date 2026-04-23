import { DockerHostingProvider } from "./docker-hosting.js";
import { DigitalOceanProvider } from "./digitalocean.js";
import { DOAppsProvider } from "./digitalocean-apps.js";
import { DokployHostingProvider } from "./dokploy-hosting.js";
import { LocalDockerProvider } from "./local-docker.js";
import { GitHubPagesProvider } from "./github-pages.js";
import type { HostingProvider } from "./types.js";

export * from "./types.js";
export {
  DockerHostingProvider,
  DigitalOceanProvider,
  DOAppsProvider,
  DokployHostingProvider,
  LocalDockerProvider,
  GitHubPagesProvider,
};

const REGISTRY: Record<string, () => HostingProvider> = {
  docker: () => new DockerHostingProvider(),
  digitalocean: () => new DigitalOceanProvider(),
  "digitalocean-apps": () => new DOAppsProvider(),
  dokploy: () => new DokployHostingProvider(),
  "local-docker": () => new LocalDockerProvider(),
  "github-pages": () => new GitHubPagesProvider(),
};

export function getHostingProvider(name: string): HostingProvider | null {
  const factory = REGISTRY[name];
  return factory ? factory() : null;
}
