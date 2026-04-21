/**
 * MCP Deploy Server for Claude Code sessions.
 * Runs as a stdio JSON-RPC server — Claude Code spawns this process.
 * Calls the AgentHub server API to deploy/manage apps.
 *
 * Environment:
 *   PORTAL_URL        — AgentHub server URL (e.g. http://10.0.0.1:3000)
 *   AGENT_TOKEN       — Per-session agent token (preferred)
 *   AGENT_AUTH_TOKEN  — Legacy shared token (fallback during transition)
 *
 * VMID is derived from the container hostname (only sent when falling back
 * to the legacy shared token).
 */

import { hostname } from "node:os";

// --- Config ---

const PORTAL_URL = process.env["PORTAL_URL"] ?? "";
// Prefer the per-session token. Falling back to the shared token keeps
// legacy pool containers working during the rollout; remove the fallback
// once the pool has cycled (default 7-day TTL).
const PER_SESSION_TOKEN = process.env["AGENT_TOKEN"] ?? "";
const LEGACY_SHARED_TOKEN = process.env["AGENT_AUTH_TOKEN"] ?? "";
const AUTH_TOKEN = PER_SESSION_TOKEN || LEGACY_SHARED_TOKEN;
const USING_LEGACY_AUTH = !PER_SESSION_TOKEN && Boolean(LEGACY_SHARED_TOKEN);

function getVmid(): string | null {
  const h = hostname();
  const match = /(?:lxc-pool-|lxc-agent-)(\d+)/.exec(h);
  return match?.[1] ?? null;
}

const VMID = getVmid();

// --- HTTP client ---

async function apiCall(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (!PORTAL_URL) {
    return { ok: false, status: 0, data: { error: "PORTAL_URL not configured" } };
  }

  const headers: Record<string, string> = {
    Authorization: `AgentToken ${AUTH_TOKEN}`,
    "Content-Type": "application/json",
  };
  // X-Vmid is only needed by the legacy server path; sending it unconditionally
  // is harmless since the new server ignores it.
  if (USING_LEGACY_AUTH && VMID) headers["X-Vmid"] = VMID;

  const url = `${PORTAL_URL}/api/agent/deploy${path}`;
  const init: RequestInit = { method, headers };
  if (body) init.body = JSON.stringify(body);

  const resp = await fetch(url, init);
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
    description: "Deploy an app to the user's hosting node. Idempotent — calling `deploy` with the same `name` updates the existing deployment in place (reuses port, domain, DNS). Either build from source (source_path) or deploy a pre-built Docker image (compose_config). For pre-built apps like n8n, Grafana, etc., research the app's Docker setup and provide a complete docker-compose.yml via compose_config.",
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
          description: "Path to project directory for building from source. Omit when using compose_config.",
        },
        compose_config: {
          type: "string" as const,
          description: "Raw docker-compose.yml content for deploying pre-built images. Research the app and generate a complete compose config with images, volumes, ports, and environment variables. Omit when using source_path.",
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
          description: "Name of the hosting infrastructure config to deploy to (e.g. 'proxmox-home', 'do-staging'). If omitted, uses the first ready config.",
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
];

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: { type: string; text: string }[] }> {
  switch (name) {
    case "deploy": {
      const body: Record<string, unknown> = {
        name: args["name"],
        domain: args["domain"],
        internalOnly: args["internal_only"] ?? false,
        database: args["database"] ?? "none",
      };
      if (args["compose_config"]) {
        body["composeConfig"] = args["compose_config"];
      } else {
        body["sourcePath"] = (args["source_path"] as string | undefined) ?? process.cwd();
      }
      if (args["compose_path"]) body["composePath"] = args["compose_path"];
      if (args["env_vars"] && typeof args["env_vars"] === "object") {
        body["envVars"] = args["env_vars"];
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
        : `${verb} started. ID: ${data.id} (internal only)`;
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
