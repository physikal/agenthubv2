import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { lte } from "drizzle-orm";
import { eq } from "drizzle-orm";

import { db, schema } from "../db/index.js";
import type { AuthUser } from "../middleware/auth.js";
import { DeployError } from "../services/deploy-error.js";
import {
  upsertGithubAppConfig,
  isGithubAppRegistered,
  loadGithubAppCreds,
} from "../services/providers/github-app.js";
import { buildManifest } from "./github-app-manifest-builder.js";

/**
 * GitHub App manifest flow (admin-only). One-time setup that registers an
 * App on GitHub using a JSON manifest — the admin clicks a button, we show
 * a temporary form that POSTs to github.com/settings/apps/new with the
 * manifest, GitHub renders a confirmation page, admin approves, GitHub
 * redirects back to our `redirect_url` with a short-lived code, we exchange
 * the code for permanent credentials (App ID, private key, webhook secret)
 * via POST /app-manifests/{code}/conversions.
 *
 * State token is a one-time CSRF nonce stored in github_install_state:
 *   - Generated when the admin starts registration.
 *   - Matched + marked used on callback. Re-use attempts are rejected.
 *
 * Manifest URLs (`redirect_url`, `callback_urls`, `setup_url`,
 * `hook_attributes.url`) use the admin's BROWSER origin, not the
 * server-side AGENTHUB_PUBLIC_URL. This means an install where compose has
 * DOMAIN=localhost but the admin is accessing AgentHub via a public tunnel
 * (Cloudflare Tunnel, ngrok, tailscale funnel) gets the tunnel URL in the
 * manifest — exactly what GitHub needs to reach. Matches how Dokploy's
 * add-github-provider.tsx drives its flow. Falls back to AGENTHUB_PUBLIC_URL
 * only if the client didn't pass an origin.
 */

const STATE_TTL_MS = 15 * 60 * 1000;

function defaultPublicUrl(): string | null {
  const url = process.env["AGENTHUB_PUBLIC_URL"];
  return url ? url.replace(/\/$/, "") : null;
}

// Pin the origin to a sane HTTPS URL before we hand it to the manifest
// builder. We don't block localhost — GitHub will reject it on submit and
// the admin sees the error there, and a same-box `https://localhost`
// install where the admin is proxying via a tunnel is a legitimate case
// (the browser-side origin IS the tunnel). We do block anything we can't
// parse as a URL, because a malformed manifest URL crashes the form post.
function validateOrigin(raw: string): { ok: string } | { err: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { err: `"${raw}" is not a valid URL — expected https://your-host.example` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { err: `"${raw}" must be http(s) — got protocol "${url.protocol}"` };
  }
  // Strip trailing slash + any path/query so callers can pass
  // window.location.href without surprises.
  return { ok: `${url.protocol}//${url.host}` };
}

export function githubAppManifestRoutes() {
  const app = new Hono<{ Variables: { user: AuthUser } }>();

  // GET /api/admin/github-app/status — surface current registration state
  // to the UI so the button can render "Register" or "Re-register".
  app.get("/status", (c) => {
    const registered = isGithubAppRegistered();
    if (!registered) return c.json({ registered: false });
    const row = db.select().from(schema.githubAppConfig).get();
    return c.json({
      registered: true,
      appId: row?.appId,
      slug: row?.slug,
      name: row?.name,
      htmlUrl: row?.htmlUrl,
    });
  });

  // GET /api/admin/github-app/register — admin kicks off the manifest
  // flow. We respond with an auto-submitting HTML form because the
  // manifest POST to github.com must originate from the admin's
  // browser, not this server. Returning HTML keeps the redirect
  // JS-free and works even if the Settings page is served by a CDN.
  app.get("/register", async (c) => {
    const user = c.get("user");

    // Prefer the browser-side origin the client passed us. Fall back to
    // AGENTHUB_PUBLIC_URL only for callers without a browser (e.g., a
    // curl debugging session) — the Integrations UI always sends it.
    const originParam = c.req.query("origin");
    const rawOrigin = originParam ?? defaultPublicUrl();
    if (!rawOrigin) {
      return c.redirect(
        `/integrations?githubAppError=${encodeURIComponent(
          "AGENTHUB_PUBLIC_URL not set and no origin supplied. Clicking Register from the Integrations page normally passes the browser's URL automatically — try again from that page.",
        )}`,
      );
    }
    const validated = validateOrigin(rawOrigin);
    if ("err" in validated) {
      return c.redirect(
        `/integrations?githubAppError=${encodeURIComponent(validated.err)}`,
      );
    }
    const publicUrl = validated.ok;

    // Purge stale state rows lazily — no cron needed for a low-volume
    // admin-only endpoint.
    db.delete(schema.githubInstallState)
      .where(
        lte(
          schema.githubInstallState.createdAt,
          new Date(Date.now() - STATE_TTL_MS),
        ),
      )
      .run();

    const state = randomBytes(32).toString("hex");
    db.insert(schema.githubInstallState)
      .values({ state, userId: user.id, createdAt: new Date() })
      .run();

    const host = new URL(publicUrl).host.replace(/[^a-z0-9-]/gi, "-");
    const manifest = buildManifest({
      publicUrl,
      appName: `AgentHub (${host})`,
    });
    const manifestJson = JSON.stringify(manifest);
    const postUrl = `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
    const html = renderAutoSubmitForm(postUrl, manifestJson);
    c.header("Content-Type", "text/html; charset=utf-8");
    // No cache — the state is one-time and embedding it in an HTML file
    // that could be replayed would defeat its purpose.
    c.header("Cache-Control", "no-store");
    return c.body(html);
  });

  // GET /api/admin/github-app/manifest-callback — GitHub redirects here
  // after the admin approves. Query params: code + state. We verify
  // state, exchange code for credentials via GitHub's API, store
  // everything, then redirect the admin to a UI success page.
  app.get("/manifest-callback", async (c) => {
    const user = c.get("user");
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) {
      return c.redirect("/integrations?githubAppError=missing_params");
    }

    const stateRow = db
      .select()
      .from(schema.githubInstallState)
      .where(eq(schema.githubInstallState.state, state))
      .get();
    if (!stateRow) {
      return c.redirect("/integrations?githubAppError=unknown_state");
    }
    if (stateRow.userId !== user.id) {
      return c.redirect("/integrations?githubAppError=state_user_mismatch");
    }
    if (stateRow.usedAt) {
      return c.redirect("/integrations?githubAppError=state_reused");
    }
    if (
      stateRow.createdAt.getTime() < Date.now() - STATE_TTL_MS
    ) {
      return c.redirect("/integrations?githubAppError=state_expired");
    }

    // Mark state used BEFORE making network calls — if anything downstream
    // hangs or fails, we still prevent replay of the same code.
    db.update(schema.githubInstallState)
      .set({ usedAt: new Date() })
      .where(eq(schema.githubInstallState.state, state))
      .run();

    let conversion: ManifestConversion;
    try {
      conversion = await exchangeManifestCode(code);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown";
      console.error("[github-app] manifest exchange failed:", detail);
      return c.redirect(
        `/integrations?githubAppError=${encodeURIComponent("exchange_failed:" + detail)}`,
      );
    }

    try {
      await upsertGithubAppConfig({
        appId: conversion.id,
        slug: conversion.slug,
        clientId: conversion.client_id,
        name: conversion.name,
        htmlUrl: conversion.html_url,
        privateKey: conversion.pem,
        webhookSecret: conversion.webhook_secret,
        clientSecret: conversion.client_secret,
        registeredByUserId: user.id,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown";
      console.error("[github-app] upsert failed:", detail);
      return c.redirect(
        `/integrations?githubAppError=${encodeURIComponent("store_failed:" + detail)}`,
      );
    }

    return c.redirect("/integrations?githubAppRegistered=1");
  });

  // DELETE /api/admin/github-app — un-register. Does NOT touch GitHub's
  // side of the registration; admin needs to delete the App at
  // github.com/organizations/X/settings/apps/<slug> to fully tear down.
  // We only purge our knowledge of it so a fresh Register starts clean.
  app.delete("/", async (c) => {
    if (!isGithubAppRegistered()) {
      return c.json({ error: "GitHub App not registered" }, 404);
    }
    // Load creds (for the user's reference) before blowing them away.
    let slug: string | undefined;
    try {
      const creds = await loadGithubAppCreds();
      slug = creds.slug;
    } catch {
      // Swallow — we're tearing down anyway.
    }
    db.delete(schema.githubAppConfig).run();
    // Secrets under /system/github-app/* are intentionally left in place;
    // operators concerned about lingering key material should rotate
    // the App on GitHub's side (which generates fresh secrets anyway).
    return c.json({ unregistered: true, slug });
  });

  return app;
}

interface ManifestConversion {
  id: number;
  slug: string;
  name: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string;
  pem: string;
  html_url: string;
}

async function exchangeManifestCode(code: string): Promise<ManifestConversion> {
  const resp = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`GitHub returned ${String(resp.status)}: ${body}`);
  }
  const data = (await resp.json()) as Partial<ManifestConversion>;
  // Defensive: GitHub returns every field on success, but if any go missing
  // we'd rather fail cleanly than persist a half-configured row.
  for (const key of [
    "id",
    "slug",
    "name",
    "client_id",
    "client_secret",
    "webhook_secret",
    "pem",
    "html_url",
  ] as const) {
    if (data[key] === undefined || data[key] === null) {
      throw new Error(`GitHub manifest response missing required field: ${key}`);
    }
  }
  return data as ManifestConversion;
}

function renderAutoSubmitForm(postUrl: string, manifestJson: string): string {
  // We html-escape the manifest JSON for the `value` attribute and echo it
  // into a hidden input. The form auto-submits on DOMContentLoaded so
  // there's no visible flash; JS-disabled admins get a clear "submit" button.
  const escape = (s: string): string =>
    s
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Registering AgentHub with GitHub…</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2em; color: #ccc; background: #18181b;">
<p>Redirecting to GitHub to finish GitHub App registration…</p>
<form id="f" action="${escape(postUrl)}" method="POST">
  <input type="hidden" name="manifest" value="${escape(manifestJson)}">
  <noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>document.getElementById("f").submit();</script>
</body>
</html>`;
}
