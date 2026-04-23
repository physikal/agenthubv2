import { describe, expect, it } from "vitest";

import { buildManifest } from "./github-app-manifest-builder.js";

describe("buildManifest", () => {
  const base = buildManifest({
    publicUrl: "https://agents.example.com",
    appName: "AgentHub (agents.example.com)",
  });

  it("names the App after the install's domain", () => {
    expect(base["name"]).toBe("AgentHub (agents.example.com)");
  });

  it("points redirect_url + callback_urls + setup_url at the public URL", () => {
    expect(base["redirect_url"]).toBe(
      "https://agents.example.com/api/admin/github-app/manifest-callback",
    );
    expect(base["callback_urls"]).toEqual([
      "https://agents.example.com/api/integrations/github/callback",
    ]);
    expect(base["setup_url"]).toBe(
      "https://agents.example.com/api/integrations/github/callback",
    );
  });

  it("requests only Contents:RW + Metadata:R (minimum-friction default)", () => {
    expect(base["default_permissions"]).toEqual({
      contents: "write",
      metadata: "read",
    });
  });

  it("does not declare any default_events (installation + installation_repositories are auto-delivered when a webhook URL is set; declaring them crashes GitHub's manifest validator)", () => {
    expect(base["default_events"]).toEqual([]);
  });

  it("is private (not listed on the Apps marketplace)", () => {
    expect(base["public"]).toBe(false);
  });

  it("enables request_oauth_on_install so we can bind install to user", () => {
    expect(base["request_oauth_on_install"]).toBe(true);
  });

  it("sets setup_on_update so repo-selection changes come back to our callback", () => {
    expect(base["setup_on_update"]).toBe(true);
  });

  it("points hook_attributes.url at the webhook endpoint", () => {
    const hook = base["hook_attributes"] as Record<string, unknown>;
    expect(hook["url"]).toBe(
      "https://agents.example.com/api/integrations/github/webhook",
    );
  });
});
