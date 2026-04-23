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
        { label: "Overview", slug: "index" },
        { label: "Getting Started", autogenerate: { directory: "getting-started" } },
        { label: "Agent CLIs", autogenerate: { directory: "clis" } },
        { label: "Web UI", autogenerate: { directory: "web-ui" } },
        { label: "Infisical", autogenerate: { directory: "infisical" } },
        { label: "agentdeploy MCP", autogenerate: { directory: "agentdeploy" } },
        { label: "Operating AgentHub", autogenerate: { directory: "operators" } },
      ],
    }),
  ],
});
