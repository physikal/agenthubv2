import { randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { and, eq, lte } from "drizzle-orm";

import { db, schema } from "../db/index.js";
import type { AuthUser } from "../middleware/auth.js";
import {
  fetchInstallationMetadata,
  installUrlFor,
  isGithubAppRegistered,
  loadGithubAppCreds,
} from "../services/providers/github-app.js";
import { verifyWebhookSignature } from "../services/providers/github-app-webhook.js";

const STATE_TTL_MS = 15 * 60 * 1000;

/**
 * Per-user GitHub App install UX. Cookie-authenticated, so the install URL
 * and callback handler both see the active AgentHub user. The webhook
 * endpoint is unauthenticated — it's GitHub talking to us — but signed
 * with the App's shared secret so unauthenticated POSTs that can't prove
 * origin are dropped.
 *
 * Install flow:
 *   1. GET /install           → redirect to GitHub
 *   2. (user approves on GitHub)
 *   3. GET /callback          → persist the installation
 *
 * Webhook stays Dokploy-minimal: we DO verify the signature (defence in
 * depth) but only handle a short list of events that materially affect
 * what we show in the UI (installation.deleted, .suspend, .unsuspend).
 * Everything else 200s without action.
 */
export function githubIntegrationRoutes() {
  const app = new Hono<{ Variables: { user: AuthUser } }>();

  // GET /api/integrations/github — list this user's installations for UI.
  app.get("/", (c) => {
    const user = c.get("user");
    const rows = db
      .select()
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.userId, user.id))
      .all();
    return c.json({
      registered: isGithubAppRegistered(),
      installations: rows.map((r) => ({
        id: r.id,
        installationId: r.installationId,
        accountLogin: r.accountLogin,
        accountType: r.accountType,
        repositorySelection: r.repositorySelection,
        suspendedAt: r.suspendedAt,
        deletedAt: r.deletedAt,
        createdAt: r.createdAt,
      })),
    });
  });

  // GET /api/integrations/github/install — user-initiated install.
  app.get("/install", async (c) => {
    const user = c.get("user");
    if (!isGithubAppRegistered()) {
      return c.json(
        {
          error:
            "GitHub App isn't registered yet — an admin needs to register it first on the Integrations page.",
        },
        409,
      );
    }
    const creds = await loadGithubAppCreds();

    // Lazy GC on stale state rows.
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

    return c.redirect(installUrlFor(creds.slug, state));
  });

  // GET /api/integrations/github/callback — receives installation_id +
  // setup_action + state after the user approves on GitHub. Also hit
  // whenever the user re-visits GitHub's install settings page for this
  // App (setup_on_update:true in the manifest), so we reconcile
  // repositorySelection + permissions each time.
  app.get("/callback", async (c) => {
    const user = c.get("user");
    const installationIdRaw = c.req.query("installation_id");
    const stateRaw = c.req.query("state");
    const setupAction = c.req.query("setup_action") ?? "install";

    if (!installationIdRaw) {
      return c.redirect("/integrations?githubInstallError=missing_installation_id");
    }
    const installationId = parseInt(installationIdRaw, 10);
    if (!Number.isFinite(installationId) || installationId <= 0) {
      return c.redirect("/integrations?githubInstallError=invalid_installation_id");
    }

    // State verification (happy path — user initiated via /install). GitHub
    // occasionally strips state in org-approval flows; when that happens
    // we fall back to OAuth-on-install user matching (request_oauth_on_install
    // = true in the manifest) — but we haven't wired OAuth yet, so for
    // now a missing state on a fresh install means "abort". Setup_update
    // re-hits omit state too, but by then we have a prior row to rely on.
    if (stateRaw) {
      const stateRow = db
        .select()
        .from(schema.githubInstallState)
        .where(eq(schema.githubInstallState.state, stateRaw))
        .get();
      if (!stateRow) {
        return c.redirect("/integrations?githubInstallError=unknown_state");
      }
      if (stateRow.userId !== user.id) {
        return c.redirect("/integrations?githubInstallError=state_user_mismatch");
      }
      if (
        stateRow.createdAt.getTime() < Date.now() - STATE_TTL_MS
      ) {
        return c.redirect("/integrations?githubInstallError=state_expired");
      }
      db.update(schema.githubInstallState)
        .set({ usedAt: new Date() })
        .where(eq(schema.githubInstallState.state, stateRaw))
        .run();
    } else {
      // setup_update callback on a known installation — OK to proceed
      // if we already have the row. If we don't, this is a suspect
      // request (no state AND no prior record), bail.
      const existing = db
        .select()
        .from(schema.githubInstallations)
        .where(
          and(
            eq(schema.githubInstallations.userId, user.id),
            eq(schema.githubInstallations.installationId, installationId),
          ),
        )
        .get();
      if (!existing) {
        return c.redirect("/integrations?githubInstallError=missing_state");
      }
    }

    let metadata;
    try {
      metadata = await fetchInstallationMetadata(installationId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown";
      console.error("[github-install] metadata fetch failed:", detail);
      return c.redirect(
        `/integrations?githubInstallError=${encodeURIComponent("metadata_failed:" + detail)}`,
      );
    }

    const existing = db
      .select()
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.installationId, installationId))
      .get();

    const now = new Date();
    if (existing) {
      if (existing.userId !== user.id) {
        // Another AgentHub user already owns this GitHub installation —
        // GitHub assigns one id per account+app, so this shouldn't happen
        // unless two users share a GitHub account. Surface but don't mutate.
        return c.redirect(
          "/integrations?githubInstallError=installation_owned_by_other_user",
        );
      }
      db.update(schema.githubInstallations)
        .set({
          accountLogin: metadata.login,
          accountType: metadata.accountType,
          targetType: metadata.targetType,
          repositorySelection: metadata.repositorySelection,
          permissions: JSON.stringify(metadata.permissions),
          // Clear any stale suspended/deleted markers — GitHub just told us
          // the install is live.
          suspendedAt: null,
          deletedAt: null,
          updatedAt: now,
        })
        .where(eq(schema.githubInstallations.id, existing.id))
        .run();
    } else {
      db.insert(schema.githubInstallations)
        .values({
          id: randomUUID(),
          userId: user.id,
          installationId,
          accountLogin: metadata.login,
          accountType: metadata.accountType,
          targetType: metadata.targetType,
          repositorySelection: metadata.repositorySelection,
          permissions: JSON.stringify(metadata.permissions),
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const verb = setupAction === "update" ? "githubInstallUpdated" : "githubInstallAdded";
    return c.redirect(`/integrations?${verb}=1`);
  });

  // DELETE /api/integrations/github/:id — remove the local row only.
  // Does NOT call GitHub's DELETE /app/installations/{id} — operator must
  // uninstall from their GitHub account (Settings → Integrations → Installed
  // GitHub Apps → Uninstall) to fully revoke. We document this in the UI.
  app.delete("/:id", (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const row = db
      .select()
      .from(schema.githubInstallations)
      .where(
        and(
          eq(schema.githubInstallations.id, id),
          eq(schema.githubInstallations.userId, user.id),
        ),
      )
      .get();
    if (!row) return c.json({ error: "Not found" }, 404);
    db.delete(schema.githubInstallations)
      .where(eq(schema.githubInstallations.id, id))
      .run();
    return c.json({ deleted: true });
  });

  return app;
}

/**
 * Webhook route — kept as a separate mount because it's unauthenticated
 * (HMAC-signed instead) and needs the raw body for signature verification,
 * which cookie-auth middleware might interfere with if we mounted it under
 * /api/integrations/github.
 */
export function githubWebhookRoutes() {
  const app = new Hono();
  app.post("/", async (c) => {
    let creds;
    try {
      creds = await loadGithubAppCreds();
    } catch {
      // App not registered yet — GitHub would never send us a delivery
      // since we provided no webhook secret, but be defensive.
      return c.json({ received: false, reason: "not_registered" }, 404);
    }
    // Read body as raw text BEFORE parsing so HMAC hashes the bytes GitHub
    // signed. Hono exposes this via c.req.text().
    const rawBody = await c.req.text();
    const sigHeader = c.req.header("x-hub-signature-256");
    const verify = verifyWebhookSignature(rawBody, sigHeader, creds.webhookSecret);
    if (!verify.ok) {
      console.warn(
        `[github-webhook] rejected delivery: ${verify.reason ?? "unknown"}`,
      );
      return c.json({ received: false }, 401);
    }

    let event;
    try {
      event = JSON.parse(rawBody) as WebhookEvent;
    } catch {
      return c.json({ received: false, reason: "malformed_json" }, 400);
    }
    const deliveryId = c.req.header("x-github-delivery") ?? "unknown";
    const eventType = c.req.header("x-github-event") ?? "unknown";

    // Only installation.* is load-bearing for the MVP. Everything else
    // 200s so GitHub doesn't retry and we don't need a feature-flag
    // release cadence tied to GitHub's event catalog.
    if (eventType === "installation" || eventType === "installation_repositories") {
      await handleInstallationEvent(event);
    }
    console.log(`[github-webhook] ${eventType} ${deliveryId} action=${event.action ?? "n/a"}`);
    return c.json({ received: true });
  });
  return app;
}

interface WebhookEvent {
  action?: string;
  installation?: { id?: number };
}

async function handleInstallationEvent(event: WebhookEvent): Promise<void> {
  const installationId = event.installation?.id;
  if (!installationId) return;
  const row = db
    .select()
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.installationId, installationId))
    .get();
  if (!row) return; // Unknown install — setup_url callback will insert when user returns.

  const now = new Date();
  switch (event.action) {
    case "deleted":
      db.update(schema.githubInstallations)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(schema.githubInstallations.id, row.id))
        .run();
      break;
    case "suspend":
      db.update(schema.githubInstallations)
        .set({ suspendedAt: now, updatedAt: now })
        .where(eq(schema.githubInstallations.id, row.id))
        .run();
      break;
    case "unsuspend":
      db.update(schema.githubInstallations)
        .set({ suspendedAt: null, updatedAt: now })
        .where(eq(schema.githubInstallations.id, row.id))
        .run();
      break;
    // added / removed from installation_repositories don't affect the
    // installation row itself — Phase 5 / a future PR can surface
    // per-repo selection if we start caching it.
  }
}
