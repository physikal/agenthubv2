/**
 * MCP Deploy Server for Claude Code sessions.
 * Runs as a stdio JSON-RPC server — Claude Code spawns this process.
 * Calls the AgentHub server API to deploy/manage apps.
 *
 * Environment:
 *   PORTAL_URL   — AgentHub server URL
 *   AGENT_TOKEN  — Per-session agent token
 */

import { introspectSource } from "./source-introspect.js";

// --- Config ---

const PORTAL_URL = process.env["PORTAL_URL"] ?? "";
const AUTH_TOKEN = process.env["AGENT_TOKEN"] ?? "";

// --- HTTP client ---

/**
 * @param path Relative to `/api/agent/deploy`. Must start with `/` (or be
 *   empty to hit the root deploy endpoint).
 */
async function apiCall(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  return apiCallAt(method, `/api/agent/deploy${path}`, body);
}

async function apiCallAt(
  method: string,
  fullPath: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (!PORTAL_URL) {
    return { ok: false, status: 0, data: { error: "PORTAL_URL not configured" } };
  }
  const headers: Record<string, string> = {
    Authorization: `AgentToken ${AUTH_TOKEN}`,
    "Content-Type": "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body) init.body = JSON.stringify(body);
  const resp = await fetch(`${PORTAL_URL}${fullPath}`, init);
  const data = (await resp.json()) as unknown;
  return { ok: resp.ok, status: resp.status, data };
}

// --- MCP Protocol ---

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const TOOLS = [
  {
    name: "deploy",
    description: "Deploy an app. Idempotent — same `name` updates in place.\n\nTwo-step flow:\n1. Call with `source_path` but NO `target`. The tool introspects the source (Dockerfile? compose? static site? git state?) and returns a `choose_target` response listing viable deploy targets with short descriptions. Surface these to the user.\n2. Call again with the chosen `target` (e.g. `local`, `dokploy:<infra_name>`, `do-apps:<infra_name>`, `gh-pages:<infra_name>`).\n\nSource modes (pick one):\n- `source_path`: project directory. On docker/DigitalOcean infra, SCP'd + built remotely. On Dokploy infra, the directory must be a clean, pushed git repo (auto-converted to a git-pull). On local-docker, copied from this workspace into the AgentHub host and built there.\n- `compose_config`: raw docker-compose.yml for pre-built images (n8n, Grafana, etc.).\n- `git_url`: HTTPS Git URL. Dokploy only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string" as const,
          description: "App name (lowercase alphanumeric + hyphens, e.g. 'my-app')",
        },
        domain: {
          type: "string" as const,
          description: "Domain for the app (e.g. 'myapp.physhlab.com'). Optional — omit for internal-only.",
        },
        source_path: {
          type: "string" as const,
          description: "Path to project directory for building from source. On Dokploy infra, the directory must be a clean, pushed git repo (auto-converted to git-pull). Omit when using compose_config or git_url.",
        },
        compose_config: {
          type: "string" as const,
          description: "Raw docker-compose.yml content for deploying pre-built images. Research the app and generate a complete compose config with images, volumes, ports, and environment variables. Omit when using source_path or git_url.",
        },
        git_url: {
          type: "string" as const,
          description: "HTTPS Git URL for 'Dokploy clones + builds from Git' flow (e.g. 'https://github.com/owner/repo.git'). Dokploy infra only — the Dokploy server handles the clone, build, and run. Omit when using source_path or compose_config.",
        },
        git_branch: {
          type: "string" as const,
          description: "Branch to deploy when using git_url. Default: 'main'.",
        },
        compose_path: {
          type: "string" as const,
          description: "Relative path (under source_path) to a docker-compose file when it's not at the project root — e.g. 'docker/docker-compose.yml'. Optional. If omitted, the deployer auto-detects compose.yaml / compose.yml / docker-compose.yaml / docker-compose.yml at root.",
        },
        env_vars: {
          type: "object" as const,
          additionalProperties: { type: "string" as const },
          description: "Environment variables to write as .env next to the compose file before build/up. Use for secrets or values referenced by the compose (DATABASE_URL, API_KEY, etc.). Docker Compose auto-loads .env for variable substitution and for services that reference `env_file: .env`.",
        },
        database: {
          type: "string" as const,
          enum: ["none", "sqlite", "postgres"],
          description: "Database to include. Default: none.",
        },
        internal_only: {
          type: "boolean" as const,
          description: "If true, skip DNS and TLS. Default: false.",
        },
        infra_name: {
          type: "string" as const,
          description: "Name of the hosting infrastructure config to deploy to (e.g. 'proxmox-home', 'do-staging'). If omitted, uses the first ready config. Prefer `target` for explicit routing.",
        },
        target: {
          type: "string" as const,
          description: "Explicit deploy target returned by the choose_target response. Values: `local` (local-docker on this AgentHub host), `dokploy:<infra_name>`, `do-apps:<infra_name>`, `gh-pages:<infra_name>`. When omitted, the tool returns `choose_target` instead of deploying.",
        },
        dns_name: {
          type: "string" as const,
          description: "Name of the Cloudflare DNS config to use for domain records (e.g. 'cf-physhlab'). If omitted, uses the first available Cloudflare config.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_deployments",
    description: "List all deployed apps for the current user.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "deployment_logs",
    description: "Get recent logs for a deployed app.",
    inputSchema: {
      type: "object" as const,
      properties: {
        deployment_id: {
          type: "string" as const,
          description: "Deployment ID to get logs for.",
        },
        lines: {
          type: "number" as const,
          description: "Number of log lines. Default: 100.",
        },
      },
      required: ["deployment_id"],
    },
  },
  {
    name: "restart_deployment",
    description: "Restart a deployed app.",
    inputSchema: {
      type: "object" as const,
      properties: {
        deployment_id: {
          type: "string" as const,
          description: "Deployment ID to restart.",
        },
      },
      required: ["deployment_id"],
    },
  },
  {
    name: "destroy_deployment",
    description: "Destroy a deployed app. Removes containers, volumes, and DNS records.",
    inputSchema: {
      type: "object" as const,
      properties: {
        deployment_id: {
          type: "string" as const,
          description: "Deployment ID to destroy.",
        },
      },
      required: ["deployment_id"],
    },
  },
  {
    name: "push_to_github",
    description:
      "Push a workspace directory to a GitHub repo. Creates the repo under the user's configured GitHub owner if it doesn't exist. Requires a GitHub integration with a PAT (scopes: contents:write, administration:write). Use this before `deploy` when targeting Dokploy, DO App Platform, or GitHub Pages — those targets pull from GitHub.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string" as const,
          description: "Absolute path to the source directory inside the workspace (e.g. '/home/coder/my-app').",
        },
        repo: {
          type: "string" as const,
          description: "Repo name (without owner). Created under the user's GitHub owner.",
        },
        private: {
          type: "boolean" as const,
          description: "Create as private. Default: false.",
        },
        commit_message: {
          type: "string" as const,
          description: "Commit message. Default: 'Initial commit'.",
        },
        description: {
          type: "string" as const,
          description: "Repo description.",
        },
      },
      required: ["path", "repo"],
    },
  },
];

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: { type: string; text: string }[] }> {
  switch (name) {
    case "deploy": {
      const sourcePath =
        (args["source_path"] as string | undefined) ?? process.cwd();
      const target = args["target"] as string | undefined;

      // Step 1: no `target` → introspect + ask the server what's viable.
      if (!target) {
        const srcIntrospect =
          args["source_path"] || args["compose_config"] || args["git_url"]
            ? introspectSource(sourcePath)
            : null;
        const analysis = srcIntrospect ?? {
          path: sourcePath,
          hasDockerfile: false,
          hasCompose: Boolean(args["compose_config"]),
          composePath: null,
          isStaticSite: false,
          hasPackageJson: false,
          gitState: null,
        };
        const probe = await apiCall("POST", "/targets", {
          source_analysis: analysis,
        });
        if (!probe.ok) {
          const err = probe.data as { error?: string };
          return {
            content: [
              {
                type: "text",
                text: `Could not list targets: ${err.error ?? "Unknown error"}`,
              },
            ],
          };
        }
        const payload = probe.data as {
          source_analysis: unknown;
          viable_targets: Array<{
            id: string;
            label: string;
            description: string;
            requires?: string[];
          }>;
        };
        const chooseTarget = {
          status: "choose_target",
          source_analysis: analysis,
          viable_targets: payload.viable_targets,
          hint: "Rerun `deploy` with the `target` arg set to one of viable_targets[].id. No automatic default — pick the one you want.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(chooseTarget, null, 2) }],
        };
      }

      // Step 2: `target` is set — build the request body and deploy.
      const body: Record<string, unknown> = {
        name: args["name"],
        domain: args["domain"],
        internalOnly: args["internal_only"] ?? false,
        database: args["database"] ?? "none",
      };
      if (args["git_url"]) {
        body["gitUrl"] = args["git_url"];
        if (args["git_branch"]) body["gitBranch"] = args["git_branch"];
      } else if (args["compose_config"]) {
        body["composeConfig"] = args["compose_config"];
      } else {
        body["sourcePath"] = sourcePath;
      }
      if (args["compose_path"]) body["composePath"] = args["compose_path"];
      if (args["env_vars"] && typeof args["env_vars"] === "object") {
        body["envVars"] = args["env_vars"];
      }

      // Translate target → infraName. `local` uses the zero-setup
      // local-docker row the server seeded for the user. Other prefixes
      // carry the user-configured infra name after the colon.
      if (target === "local") {
        body["infraName"] = "Local Docker";
      } else {
        const colon = target.indexOf(":");
        if (colon === -1) {
          return {
            content: [
              {
                type: "text",
                text: `Unknown target "${target}". Expected \`local\` or \`<kind>:<infra_name>\`.`,
              },
            ],
          };
        }
        body["infraName"] = target.slice(colon + 1);
      }

      if (args["infra_name"]) body["infraName"] = args["infra_name"];
      if (args["dns_name"]) body["dnsName"] = args["dns_name"];
      const result = await apiCall("POST", "", body);

      if (!result.ok) {
        const err = result.data as { error?: string };
        return { content: [{ type: "text", text: `Deploy failed: ${err.error ?? "Unknown error"}` }] };
      }

      // 200 = updated existing deployment, 201 = created new
      const verb = result.status === 200 ? "Update" : "Deployment";
      const data = result.data as { id: string; url: string | null };
      const msg = data.url
        ? `${verb} started. ID: ${data.id}\nURL: ${data.url} (will be live once build completes)`
        : `${verb} started. ID: ${data.id} — poll list_deployments for the URL once the build completes.`;
      return { content: [{ type: "text", text: msg }] };
    }

    case "list_deployments": {
      const result = await apiCall("GET", "/deployments");
      if (!result.ok) {
        return { content: [{ type: "text", text: "Failed to list deployments" }] };
      }

      const deployments = result.data as {
        id: string;
        name: string;
        domain: string | null;
        url: string | null;
        status: string;
        statusDetail: string | null;
        createdAt: number;
      }[];

      if (deployments.length === 0) {
        return { content: [{ type: "text", text: "No active deployments." }] };
      }

      const lines = deployments.map((d) => {
        const url = d.url ?? (d.domain ? `https://${d.domain}` : "(no URL)");
        const detail = d.status === "failed" && d.statusDetail
          ? ` — ${d.statusDetail}`
          : "";
        return `- ${d.name} [${d.status}] ${url} (ID: ${d.id})${detail}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "deployment_logs": {
      const id = args["deployment_id"] as string;
      const lines = (args["lines"] as number | undefined) ?? 100;
      const result = await apiCall("GET", `/deployments/${id}/logs?lines=${String(lines)}`);

      if (!result.ok) {
        const err = result.data as { error?: string };
        return { content: [{ type: "text", text: `Failed: ${err.error ?? "Unknown error"}` }] };
      }

      const data = result.data as { logs: string };
      return { content: [{ type: "text", text: data.logs || "(no logs)" }] };
    }

    case "restart_deployment": {
      const id = args["deployment_id"] as string;
      const result = await apiCall("POST", `/deployments/${id}/restart`);

      if (!result.ok) {
        const err = result.data as { error?: string };
        return { content: [{ type: "text", text: `Restart failed: ${err.error ?? "Unknown error"}` }] };
      }
      return { content: [{ type: "text", text: "Deployment restarted." }] };
    }

    case "destroy_deployment": {
      const id = args["deployment_id"] as string;
      const result = await apiCall("DELETE", `/deployments/${id}`);

      if (!result.ok) {
        const err = result.data as { error?: string };
        return { content: [{ type: "text", text: `Destroy failed: ${err.error ?? "Unknown error"}` }] };
      }
      return { content: [{ type: "text", text: "Deployment destroyed." }] };
    }

    case "push_to_github": {
      const body: Record<string, unknown> = {
        path: args["path"],
        repo: args["repo"],
      };
      if (typeof args["private"] === "boolean") body["private"] = args["private"];
      if (args["commit_message"]) body["commitMessage"] = args["commit_message"];
      if (args["description"]) body["description"] = args["description"];

      const result = await apiCallAt("POST", "/api/agent/github/push", body);
      if (!result.ok) {
        const err = result.data as { error?: string };
        return {
          content: [
            { type: "text", text: `GitHub push failed: ${err.error ?? "Unknown error"}` },
          ],
        };
      }
      const data = result.data as { repo: string; cloneUrl: string; branch: string };
      return {
        content: [
          {
            type: "text",
            text: `Pushed to ${data.repo} on branch ${data.branch}.\nClone URL: ${data.cloneUrl}`,
          },
        ],
      };
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
}

function handleRequest(req: JsonRpcRequest): JsonRpcResponse | Promise<JsonRpcResponse> {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize": {
      const clientVersion = (req.params as Record<string, unknown> | undefined)?.["protocolVersion"] as string | undefined;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: clientVersion ?? "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "agenthub-deploy", version: "1.0.0" },
        },
      };
    }

    case "notifications/initialized":
      // Notification — no response needed, return null id to suppress send
      return { jsonrpc: "2.0", id: null, result: {} };

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call": {
      const params = req.params as { name: string; arguments?: Record<string, unknown> } | undefined;
      if (!params?.name) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: "Missing tool name" } };
      }
      return handleToolCall(params.name, params.arguments ?? {}).then(
        (result) => ({ jsonrpc: "2.0" as const, id, result }),
        (err) => ({
          jsonrpc: "2.0" as const,
          id,
          result: {
            content: [{
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
            }],
            isError: true,
          },
        }),
      );
    }

    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${req.method}` } };
  }
}

// --- Newline-delimited JSON stdio transport ---

function send(msg: JsonRpcResponse): void {
  if (msg.id === null) return; // Don't send responses to notifications
  process.stdout.write(JSON.stringify(msg) + "\n");
}

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const req = JSON.parse(line) as JsonRpcRequest;
      const result = handleRequest(req);

      if (result instanceof Promise) {
        void result.then((resp) => send(resp));
      } else {
        send(result);
      }
    } catch {
      // Ignore malformed lines
    }
  }
});

process.stdin.on("end", () => process.exit(0));
