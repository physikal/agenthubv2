import providersJson from "./lego-providers.json" with { type: "json" };

interface ProviderManifest {
  providers: Record<string, string[]>;
}

const manifest = providersJson as ProviderManifest;

/**
 * Returns the list of env var names lego requires for the given provider, or
 * null if the provider isn't in our static manifest. Caller policy: if null,
 * surface to the user with "we don't have this provider in our list — set
 * any env vars lego needs in your shell and proceed; we'll forward verbatim".
 */
export function requiredEnvVarsFor(provider: string): string[] | null {
  return manifest.providers[provider] ?? null;
}

export function knownProviders(): string[] {
  return Object.keys(manifest.providers).sort();
}
