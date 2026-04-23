/**
 * Pure GitHub App manifest builder, split out of ./github-app-manifest.ts so
 * unit tests don't drag in the SQLite side-effect from ../db/index.ts when
 * just wanting to validate the shape we send to GitHub.
 */

// Pin a client-supplied origin to a sane HTTPS URL before we hand it to
// the manifest builder. We don't block localhost — GitHub will reject it
// on submit and the admin sees the error there, and a same-box
// `https://localhost` install where the admin is proxying via a tunnel
// is a legitimate case (the browser-side origin IS the tunnel). We do
// block anything we can't parse as a URL or that uses a non-http(s)
// protocol (e.g. javascript:), because those crash the form post or
// open XSS-adjacent vectors.
//
// Returns the canonical `${protocol}//${host}` on success, or an Error
// with a user-facing message on failure.
export function validateOrigin(raw: string): string | Error {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return new Error(
      `"${raw}" is not a valid URL — expected https://your-host.example`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return new Error(
      `"${raw}" must be http(s) — got protocol "${url.protocol}"`,
    );
  }
  // Strip trailing slash + any path/query so callers can pass
  // window.location.href without surprises.
  return `${url.protocol}//${url.host}`;
}

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
    // GitHub rejects manifests that list `installation` / `installation_repositories`
    // in `default_events` with:
    //   "Default events unsupported: installation and installation_repositories"
    //   "Default events are not supported by permissions: ..."
    // because those events aren't repo-scoped webhook subscriptions — they're
    // app-scoped lifecycle events that GitHub ALWAYS delivers to the app's
    // webhook URL regardless of default_events. Since that's all we care
    // about (see `github-integration.ts` webhook handler), we subscribe to
    // no repo events.
    default_events: [],
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
