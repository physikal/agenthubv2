/**
 * Pure GitHub App manifest builder, split out of ./github-app-manifest.ts so
 * unit tests don't drag in the SQLite side-effect from ../db/index.ts when
 * just wanting to validate the shape we send to GitHub.
 */

export interface ManifestOptions {
  /** The AgentHub public URL, e.g. "https://agenthub.example.com". */
  publicUrl: string;
  /** User-facing App name. Must be unique across the App's target account;
   * we append a short suffix to the install's domain to avoid common
   * clashes with other AgentHub installs registered on the same GitHub
   * account. */
  appName: string;
}

export function buildManifest(opts: ManifestOptions): Record<string, unknown> {
  return {
    name: opts.appName,
    url: opts.publicUrl,
    hook_attributes: {
      url: `${opts.publicUrl}/api/integrations/github/webhook`,
    },
    redirect_url: `${opts.publicUrl}/api/admin/github-app/manifest-callback`,
    callback_urls: [`${opts.publicUrl}/api/integrations/github/callback`],
    setup_url: `${opts.publicUrl}/api/integrations/github/callback`,
    // Phase-0 scope choice: Contents:RW + Metadata:R. Minimum-friction
    // install (no admin approval required in orgs) and narrow blast radius.
    default_permissions: {
      contents: "write",
      metadata: "read",
    },
    default_events: ["installation", "installation_repositories"],
    // Trigger OAuth on install so we can bind the installation to the
    // AgentHub user who initiated it (defense-in-depth with the state
    // token — admins might finish installs in a different browser).
    request_oauth_on_install: true,
    public: false,
    // Surface setup_url again when the user toggles granted repos from
    // GitHub's UI — lets us capture the new `repositorySelection` state.
    setup_on_update: true,
  };
}
