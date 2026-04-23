import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// AgentHub user manual. Builds to `dist/` (relative to this package) and is
// copied into the server image at `packages/server/dist/public/docs/` so the
// Hono server can serve it at `/docs/*`.
//
// The `base: "/docs"` makes Starlight generate links under that subpath so the
// same build works both under the production server and via `astro dev` at
// http://localhost:4321/docs/.
export default defineConfig({
  base: "/docs",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "AgentHub",
      description: "User manual for self-hosted AgentHub v2.",
      logo: {
        src: "./src/assets/agenthub.svg",
        replacesTitle: false,
      },
      customCss: ["./src/styles/custom.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/physikal/agenthubv2",
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "What is AgentHub?", slug: "getting-started/what-is-agenthub" },
            { label: "Your first session", slug: "getting-started/first-session" },
            { label: "How the install works", slug: "getting-started/install-modes" },
          ],
        },
        {
          label: "Agent CLIs",
          items: [
            { label: "Overview", slug: "clis/overview" },
            { label: "Claude Code", slug: "clis/claude-code" },
            { label: "OpenCode", slug: "clis/opencode" },
            { label: "MiniMax", slug: "clis/minimax" },
            { label: "Droid (Factory AI)", slug: "clis/droid" },
            { label: "Supporting tools", slug: "clis/supporting-tools" },
          ],
        },
        {
          label: "Web UI",
          items: [
            { label: "Sessions", slug: "web-ui/sessions" },
            { label: "Packages", slug: "web-ui/packages" },
            { label: "Integrations", slug: "web-ui/integrations" },
            { label: "Backups", slug: "web-ui/backups" },
            { label: "Secrets", slug: "web-ui/secrets" },
            { label: "Deployments", slug: "web-ui/deployments" },
            { label: "Settings", slug: "web-ui/settings" },
          ],
        },
        {
          label: "Integrations",
          items: [
            { label: "GitHub App", slug: "integrations/github-app" },
          ],
        },
        {
          label: "Infisical",
          items: [
            { label: "Why Infisical", slug: "infisical/overview" },
            { label: "Using the console", slug: "infisical/console" },
          ],
        },
        {
          label: "agentdeploy MCP",
          items: [
            { label: "What it does", slug: "agentdeploy/overview" },
            { label: "Supported providers", slug: "agentdeploy/providers" },
          ],
        },
        {
          label: "Operating AgentHub",
          items: [
            { label: "The agenthub CLI", slug: "operators/cli" },
            { label: "Updates", slug: "operators/updates" },
            { label: "Data & volumes", slug: "operators/data" },
            { label: "Troubleshooting", slug: "operators/troubleshooting" },
          ],
        },
      ],
    }),
  ],
});
