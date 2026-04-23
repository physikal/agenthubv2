import type {
  HostingProvider,
  ProviderConfigCheck,
  ProvisionResult,
} from "./types.js";
import { loadGitHubCreds } from "./github.js";

/**
 * GitHub Pages deploy target. Depends on the user's `github` integration
 * for the PAT — this provider has no credentials of its own; its config
 * is just a pointer "use Pages + the user's GitHub token."
 *
 * Static sites only. SPAs that build to `dist/` / `build/` / `public/`
 * work when the user's workflow uploads an artifact, or when they
 * configure Pages to serve the build dir from a branch.
 */
export class GitHubPagesProvider implements HostingProvider {
  readonly name = "github-pages" as const;

  validate(_config: Record<string, unknown>): ProviderConfigCheck {
    return { ok: true, issues: [] };
  }

  async verify(_config: Record<string, unknown>): Promise<ProviderConfigCheck> {
    // Nothing to verify in the `github-pages` row itself. The
    // /api/deploy/targets endpoint is responsible for ensuring the user
    // has a `github` integration before listing github-pages as viable.
    return { ok: true, issues: [] };
  }

  async provision(
    _config: Record<string, unknown>,
    _opts: { userId: string; name: string },
  ): Promise<ProvisionResult> {
    return Promise.resolve({
      hostingNodeIp: "github-pages",
      hostingNodeId: "github-pages",
      hostingNodeLabel: "github-pages",
    });
  }

  async destroy(
    _config: Record<string, unknown>,
    _hostingNodeId: string,
  ): Promise<void> {
    return Promise.resolve();
  }
}

// Small helper exported alongside the provider — used by the deployer to
// assert the github integration is present before attempting to enable
// Pages.
export async function requireGitHubCreds(userId: string): Promise<
  NonNullable<Awaited<ReturnType<typeof loadGitHubCreds>>>
> {
  const creds = await loadGitHubCreds(userId);
  if (!creds) {
    throw new Error(
      "GitHub Pages requires a `github` integration configured with a PAT (scopes: pages:write, contents:read).",
    );
  }
  return creds;
}
