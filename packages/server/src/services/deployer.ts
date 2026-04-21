import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, and } from "drizzle-orm";
import yaml from "js-yaml";
import { db, schema } from "../db/index.js";
import {
  SSH_OPTS,
  assertSafeDeploymentName as assertSafeName,
  assertSafeUserId,
  shQuote,
  sshWriteFile,
} from "./shell-safety.js";

const execFileAsync = promisify(execFile);

interface DeployInput {
  userId: string;
  infraId: string;
  name: string;
  domain?: string | undefined;
  internalOnly?: boolean | undefined;
  sourcePath?: string | undefined;
  composeConfig?: string | undefined;
  /** Path to the compose file, relative to sourcePath. Defaults to
   * compose.yaml / compose.yml / docker-compose.yaml / docker-compose.yml
   * at the project root (in that order). */
  composePath?: string | undefined;
  /** Environment variables to write to `${appDir}/.env` before compose-up.
   * Docker Compose auto-loads `.env` for substitution and for services that
   * reference `env_file: .env`. */
  envVars?: Record<string, string> | undefined;
  database?: "none" | "sqlite" | "postgres" | undefined;
  dnsName?: string | undefined;
  /** Update an existing deployment in place instead of creating a new one.
   * When set, the route layer has already verified the deployment exists
   * for this user and passes the stable ID — we reuse the host port, domain,
   * and skip DNS creation since the record already exists. */
  existingDeployId?: string | undefined;
  /** Host port for the existing deployment when updating. Parsed from
   * the stored URL (`http://host:PORT`) so we keep the same exposed port
   * across updates. Unused for domain-only deployments. */
  existingHostPort?: number | undefined;
}

interface DeployResult {
  id: string;
  url: string | null;
}

async function sshExec(ip: string, command: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "ssh",
    [...SSH_OPTS, `root@${ip}`, command],
    { timeout: 120_000 },
  );
  return stdout.trim();
}

async function scpToHost(
  ip: string,
  localPath: string,
  remotePath: string,
): Promise<void> {
  await execFileAsync(
    "scp",
    [...SSH_OPTS, "-r", localPath, `root@${ip}:${remotePath}`],
    { timeout: 300_000 },
  );
}

function nextAvailableHostPort(infraId: string): number {
  const BASE_PORT = 8001;
  const active = db
    .select({ url: schema.deployments.url })
    .from(schema.deployments)
    .where(eq(schema.deployments.infraId, infraId))
    .all()
    .filter((d) => d.url);

  const usedPorts = new Set<number>();
  for (const d of active) {
    if (!d.url) continue;
    const match = /:(\d+)$/.exec(d.url);
    if (match?.[1]) usedPorts.add(parseInt(match[1], 10));
  }

  let port = BASE_PORT;
  while (usedPorts.has(port)) port++;
  return port;
}

function generateCompose(
  name: string,
  domain: string | undefined,
  database: string,
  dbPassword: string,
  containerPort: number,
  hostPort: number | undefined,
): string {
  const lines: string[] = ["services:", "  app:", "    build: .", "    restart: unless-stopped"];

  if (domain) {
    lines.push(
      "    labels:",
      '      - "traefik.enable=true"',
      `      - "traefik.http.routers.${name}.rule=Host(\`${domain}\`)"`,
      `      - "traefik.http.routers.${name}.tls.certresolver=letsencrypt"`,
      `      - "traefik.http.routers.${name}.entrypoints=websecure"`,
    );
  } else {
    // No domain — publish on unique host port so multiple apps don't conflict
    const hp = hostPort ?? containerPort;
    lines.push("    ports:", `      - "${String(hp)}:${String(containerPort)}"`);
  }

  lines.push("    volumes:", "      - app-data:/data");

  const envVars = [`      - PORT=${String(containerPort)}`];
  if (database === "postgres") {
    envVars.push(`      - DATABASE_URL=postgresql://${name}:${dbPassword}@db:5432/${name}`);
  }
  lines.push("    environment:", ...envVars);

  if (database === "postgres") {
    lines.push(
      "    depends_on:",
      "      - db",
      "",
      "  db:",
      "    image: postgres:16-alpine",
      "    restart: unless-stopped",
      "    volumes:",
      "      - db-data:/var/lib/postgresql/data",
      "    environment:",
      `      - POSTGRES_DB=${name}`,
      `      - POSTGRES_USER=${name}`,
      `      - POSTGRES_PASSWORD=${dbPassword}`,
    );
  }

  lines.push("", "volumes:", "  app-data:");
  if (database === "postgres") {
    lines.push("  db-data:");
  }

  return lines.join("\n");
}

/**
 * Return the first compose filename (docker-compose.yml / compose.yml /
 * .yaml variants) present at the project root, or null if none. Searched
 * in the canonical-filename order Docker Compose itself uses.
 */
async function findUserCompose(hostIp: string, appDir: string): Promise<string | null> {
  const candidates = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
  for (const name of candidates) {
    const result = await sshExec(
      hostIp,
      `test -f ${shQuote(`${appDir}/${name}`)} && echo yes || echo no`,
    );
    if (result === "yes") return name;
  }
  return null;
}

interface ComposeDoc {
  services?: Record<string, ComposeService>;
}
interface ComposeService {
  ports?: Array<string | ComposePortObject>;
  env_file?: string | string[];
}
interface ComposePortObject {
  target?: number;
  published?: number | string;
  protocol?: string;
  host_ip?: string;
}

/**
 * Parse a compose file and return the first externally-reachable TCP
 * `published` port. Handles all five port shapes docker-compose accepts:
 *   "8080:80"                       short
 *   "8080:80/tcp"                   proto-qualified
 *   "127.0.0.1:8080:80"             IP-bound
 *   "8000-8010:8000-8010"           ranges (we take the first of the range)
 *   { target, published, protocol } long-form object
 *
 * Returns the host port as number. Null when no public TCP port found
 * (e.g. only UDP services, or only `expose:` entries).
 */
export function firstPublicTcpPort(composeText: string): number | null {
  let doc: ComposeDoc;
  try {
    doc = (yaml.load(composeText) ?? {}) as ComposeDoc;
  } catch {
    return null;
  }
  const services = doc.services ?? {};
  for (const svc of Object.values(services)) {
    const ports = svc.ports ?? [];
    for (const entry of ports) {
      if (typeof entry === "string") {
        // Strip optional protocol suffix. Skip UDP.
        const slashIdx = entry.lastIndexOf("/");
        const proto = slashIdx !== -1 ? entry.slice(slashIdx + 1).toLowerCase() : "tcp";
        if (proto !== "tcp") continue;
        const spec = slashIdx !== -1 ? entry.slice(0, slashIdx) : entry;
        const parts = spec.split(":");
        // parts is [container] | [host, container] | [ip, host, container]
        if (parts.length < 2) continue;
        const host = parts.length === 3 ? parts[1] : parts[0];
        if (!host) continue;
        // Handle ranges like "8000-8010"
        const rangeStart = host.split("-")[0];
        if (!rangeStart) continue;
        const n = parseInt(rangeStart, 10);
        if (Number.isFinite(n) && n > 0 && n < 65536) return n;
      } else if (typeof entry === "object" && entry !== null) {
        const proto = (entry.protocol ?? "tcp").toLowerCase();
        if (proto !== "tcp") continue;
        const raw = entry.published;
        if (raw === undefined) continue;
        const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
        if (Number.isFinite(n) && n > 0 && n < 65536) return n;
      }
    }
  }
  return null;
}

/**
 * Return env_file references in the compose that point outside the
 * project dir (relative paths starting with `..`, or any absolute path).
 * Informational — we warn the user via statusDetail; the deploy continues.
 */
export function externalEnvFileRefs(composeText: string): string[] {
  let doc: ComposeDoc;
  try {
    doc = (yaml.load(composeText) ?? {}) as ComposeDoc;
  } catch {
    return [];
  }
  const flagged: string[] = [];
  for (const svc of Object.values(doc.services ?? {})) {
    const raw = svc.env_file;
    const refs = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const ref of refs) {
      if (ref.startsWith("/") || ref.startsWith("..") || ref.includes("/../")) {
        flagged.push(ref);
      }
    }
  }
  return flagged;
}

/** Serialize a KV map into a dotenv file body. Escapes newlines and `"`. */
function serializeEnv(vars: Record<string, string>): string {
  const lines: string[] = [];
  for (const [rawKey, value] of Object.entries(vars)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawKey)) continue; // skip invalid keys
    // Always double-quote: simplest safe serialization. Escape " and \.
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
    lines.push(`${rawKey}="${escaped}"`);
  }
  return lines.join("\n") + "\n";
}

async function generateDockerfile(
  hostIp: string,
  appDir: string,
): Promise<string> {
  // Detect project type from files on the hosting node. Using exit-code via
  // `&& echo yes || echo no` instead of try/catch so a real SSH failure
  // (network blip) surfaces as an error rather than silently falling back to nginx.
  const result = await sshExec(
    hostIp,
    `test -f ${shQuote(`${appDir}/package.json`)} && echo yes || echo no`,
  );
  if (result === "yes") {
    return `FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
`;
  }
  return `FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
`;
}

async function createCloudflareDns(
  cfToken: string,
  cfZoneId: string,
  domain: string,
  ip: string,
): Promise<void> {
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${cfZoneId}/dns_records`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "A",
        name: domain,
        content: ip,
        proxied: false,
        ttl: 300,
      }),
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Cloudflare DNS creation failed: ${body}`);
  }
}

async function deleteCloudflareDns(
  cfToken: string,
  cfZoneId: string,
  domain: string,
): Promise<void> {
  // List records to find the one to delete
  const listResp = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${cfZoneId}/dns_records?name=${domain}`,
    {
      headers: { Authorization: `Bearer ${cfToken}` },
    },
  );

  if (!listResp.ok) return;

  const data = (await listResp.json()) as {
    result: { id: string; name: string }[];
  };

  for (const record of data.result) {
    if (record.name === domain) {
      await fetch(
        `https://api.cloudflare.com/client/v4/zones/${cfZoneId}/dns_records/${record.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${cfToken}` },
        },
      );
    }
  }
}

export async function deploy(input: DeployInput): Promise<DeployResult> {
  const infraRows = db
    .select()
    .from(schema.infrastructureConfigs)
    .where(eq(schema.infrastructureConfigs.id, input.infraId))
    .all();

  const infra = infraRows[0];
  if (!infra) throw new Error("Infrastructure config not found");
  if (infra.status !== "ready") throw new Error("Hosting node not ready");
  if (!infra.hostingNodeIp) throw new Error("Hosting node has no IP");

  const hostIp = infra.hostingNodeIp;
  const database = input.database ?? "none";
  const dbPassword = randomUUID().replace(/-/g, "").slice(0, 24);
  const isUpdate = Boolean(input.existingDeployId);
  const deployId = input.existingDeployId ?? randomUUID();

  const now = new Date();
  if (isUpdate) {
    // Flip existing row back to "deploying" so the UI shows progress and
    // a concurrent poll doesn't see stale "running" during the rebuild.
    db.update(schema.deployments)
      .set({
        status: "deploying",
        statusDetail: "Updating...",
        sourcePath: input.sourcePath ?? null,
        updatedAt: now,
      })
      .where(eq(schema.deployments.id, deployId))
      .run();
  } else {
    db.insert(schema.deployments)
      .values({
        id: deployId,
        userId: input.userId,
        infraId: input.infraId,
        name: input.name,
        domain: input.domain ?? null,
        internalOnly: input.internalOnly ?? false,
        status: "deploying",
        statusDetail: "Copying files...",
        sourcePath: input.sourcePath,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  // Run deploy in background
  void (async () => {
    try {
      // `input.name` was validated by the route layer (assertSafeName) and
      // is used in multiple command strings below; `userId` came from the
      // authenticated session. Re-check here in case deploy() is ever called
      // from a path that skips the route validator.
      assertSafeName(input.name);
      assertSafeUserId(input.userId);

      const appDir = `/opt/apps/${input.name}`;
      const quotedAppDir = shQuote(appDir);
      await sshExec(hostIp, `mkdir -p ${quotedAppDir}`);

      let compose: string;
      let hostPort: number | undefined;

      if (input.composeConfig) {
        // --- Pre-built image deploy (compose_config provided) ---
        // composeConfig is user-supplied. Write via stdin, not heredoc —
        // otherwise content containing `COMPOSE_EOF` on its own line escapes
        // to the surrounding shell (RCE on the hosting node).
        compose = input.composeConfig;
        updateDeployment(deployId, { statusDetail: "Writing compose config..." });
        await sshWriteFile(hostIp, `${appDir}/docker-compose.yml`, compose);

        if (input.envVars && Object.keys(input.envVars).length > 0) {
          await sshWriteFile(hostIp, `${appDir}/.env`, serializeEnv(input.envVars));
        }

        updateDeployment(deployId, { statusDetail: "Pulling images..." });
        await sshExec(hostIp, `cd ${quotedAppDir} && docker compose pull 2>/dev/null; docker compose up -d`);

        // Use YAML-based port detection (handles ranges, ip-bound, /tcp suffix, etc.)
        hostPort = firstPublicTcpPort(compose) ?? undefined;
      } else if (input.sourcePath) {
        // --- Source-code deploy (existing flow) ---
        // sourcePath was regex-validated at the route layer. nfsPath is
        // scoped to the user's own home by userId (UUID-validated above).
        const nfsPath = `/homes/${input.userId}/${input.sourcePath.replace(/^\/home\/coder\//, "")}`;
        updateDeployment(deployId, { statusDetail: "Copying project files..." });
        await scpToHost(hostIp, `${nfsPath}/.`, appDir);

        // If the user's project already has a docker-compose.yml (or compose.yml)
        // at root OR they specified composePath pointing at one, use it as-is.
        // Don't overwrite their multi-service setup with our single-service
        // template. `docker compose up -d --build` handles `build:` directives.
        let userCompose: string | null = null;
        if (input.composePath) {
          // Allow subfolder paths like "docker/docker-compose.yml".
          if (!/^[a-zA-Z0-9._\-\/]+$/.test(input.composePath) || input.composePath.includes("..")) {
            throw new Error(`Invalid composePath: ${input.composePath}`);
          }
          const check = await sshExec(
            hostIp,
            `test -f ${shQuote(`${appDir}/${input.composePath}`)} && echo yes || echo no`,
          );
          if (check !== "yes") {
            throw new Error(`composePath "${input.composePath}" not found in project`);
          }
          userCompose = input.composePath;
        } else {
          userCompose = await findUserCompose(hostIp, appDir);
        }

        if (userCompose) {
          updateDeployment(deployId, { statusDetail: `Using ${userCompose} from project...` });
          compose = await sshExec(hostIp, `cat ${shQuote(`${appDir}/${userCompose}`)}`);

          // Write user-provided env vars to `${composeDir}/.env` — Docker
          // Compose auto-loads it for variable substitution and env_file.
          if (input.envVars && Object.keys(input.envVars).length > 0) {
            updateDeployment(deployId, { statusDetail: "Writing .env..." });
            const composeDir = userCompose.includes("/")
              ? `${appDir}/${userCompose.slice(0, userCompose.lastIndexOf("/"))}`
              : appDir;
            await sshWriteFile(hostIp, `${composeDir}/.env`, serializeEnv(input.envVars));
          }

          // Surface any external env_file references as a warning — deploy
          // still proceeds; user may need to pass those vars via envVars.
          const external = externalEnvFileRefs(compose);
          if (external.length > 0) {
            console.warn(
              `[deploy] ${input.name} references env_file paths outside the project: ${external.join(", ")} — pass them via envVars if needed`,
            );
          }

          hostPort = input.domain ? undefined : firstPublicTcpPort(compose) ?? undefined;

          // Run compose from project root with explicit -f so subdir paths work.
          const composeFlag = ` -f ${shQuote(`./${userCompose}`)}`;
          updateDeployment(deployId, { statusDetail: "Building + starting containers..." });
          await sshExec(hostIp, `cd ${quotedAppDir} && docker compose${composeFlag} up -d --build`);
        } else {
          // --- Auto-generate single-service Dockerfile + compose ---
          updateDeployment(deployId, { statusDetail: "Checking Dockerfile..." });
          const hasDockerfile = await sshExec(
            hostIp,
            `test -f ${shQuote(`${appDir}/Dockerfile`)} && echo yes || echo no`,
          );
          if (hasDockerfile !== "yes") {
            const dockerfile = await generateDockerfile(hostIp, appDir);
            await sshWriteFile(hostIp, `${appDir}/Dockerfile`, dockerfile);
          }

          let containerPort = 3000;
          try {
            const exposeMatch = await sshExec(
              hostIp,
              `grep -i '^EXPOSE' ${shQuote(`${appDir}/Dockerfile`)} | head -1 | grep -oE '[0-9]+'`,
            );
            if (exposeMatch) {
              const parsed = parseInt(exposeMatch, 10);
              if (!Number.isNaN(parsed)) containerPort = parsed;
            }
          } catch {
            try {
              const fromLine = await sshExec(
                hostIp,
                `grep -i '^FROM' ${shQuote(`${appDir}/Dockerfile`)} | head -1`,
              );
              if (/nginx|httpd|apache/i.test(fromLine)) containerPort = 80;
            } catch { /* default 3000 */ }
          }

          // On update, reuse the port that was assigned when first deployed —
          // otherwise the Cloudflare DNS record (domain-less deploys skip this,
          // but port-based URLs we logged) or user-bookmarked URL goes stale.
          hostPort = input.domain
            ? undefined
            : (input.existingHostPort ?? nextAvailableHostPort(input.infraId));

          updateDeployment(deployId, { statusDetail: "Generating compose config..." });
          compose = generateCompose(input.name, input.domain, database, dbPassword, containerPort, hostPort);
          await sshWriteFile(hostIp, `${appDir}/docker-compose.yml`, compose);

          updateDeployment(deployId, { statusDetail: "Building Docker image..." });
          await sshExec(hostIp, `cd ${quotedAppDir} && docker compose build`);

          updateDeployment(deployId, { statusDetail: "Starting containers..." });
          await sshExec(hostIp, `cd ${quotedAppDir} && docker compose up -d`);
        }
      } else {
        throw new Error("Either sourcePath or composeConfig required");
      }

      let containerId: string | null = null;
      try {
        containerId = await sshExec(
          hostIp,
          `cd ${quotedAppDir} && docker compose ps -q | head -1`,
        );
      } catch { /* non-critical */ }

      // Create DNS record via Cloudflare config (separate from hosting config).
      // Skip on update — the record already exists and pointing it at the same
      // host on every redeploy just hammers the Cloudflare API.
      if (input.domain && !input.internalOnly && !isUpdate) {
        const cfConfigs = db
          .select()
          .from(schema.infrastructureConfigs)
          .where(
            and(
              eq(schema.infrastructureConfigs.userId, input.userId),
              eq(schema.infrastructureConfigs.provider, "cloudflare"),
            ),
          )
          .all();

        // Match by dnsName if specified, otherwise use first Cloudflare config
        const cfConfig = input.dnsName
          ? cfConfigs.find((c) => c.name === input.dnsName)
          : cfConfigs[0];

        if (cfConfig) {
          const cf = JSON.parse(cfConfig.config) as { apiToken: string; zoneId: string };
          updateDeployment(deployId, { statusDetail: "Creating DNS record..." });
          await createCloudflareDns(cf.apiToken, cf.zoneId, input.domain, hostIp);
        }
      }

      const url = input.domain
        ? `https://${input.domain}`
        : `http://${hostIp}:${String(hostPort ?? 3000)}`;

      db.update(schema.deployments)
        .set({
          status: "running",
          statusDetail: null,
          url,
          containerId,
          composeConfig: compose.replace(/POSTGRES_PASSWORD=.*/g, "POSTGRES_PASSWORD=***"),
          updatedAt: new Date(),
        })
        .where(eq(schema.deployments.id, deployId))
        .run();

      console.log(`[deploy] ${input.name} deployed to ${url ?? hostIp}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[deploy] Failed: ${message}`);

      db.update(schema.deployments)
        .set({
          status: "failed",
          statusDetail: message,
          updatedAt: new Date(),
        })
        .where(eq(schema.deployments.id, deployId))
        .run();
    }
  })();

  return {
    id: deployId,
    url: input.domain ? `https://${input.domain}` : null,
  };
}

export async function getDeploymentLogs(
  deployId: string,
  userId: string,
  lines = 100,
  isAdmin = false,
): Promise<string> {
  const rows = db
    .select()
    .from(schema.deployments)
    .where(eq(schema.deployments.id, deployId))
    .all();

  const deployment = rows[0];
  if (!deployment || (!isAdmin && deployment.userId !== userId)) {
    throw new Error("Deployment not found");
  }

  const infraRows = db
    .select()
    .from(schema.infrastructureConfigs)
    .where(eq(schema.infrastructureConfigs.id, deployment.infraId))
    .all();

  const infra = infraRows[0];
  if (!infra?.hostingNodeIp) throw new Error("Hosting node not available");

  assertSafeName(deployment.name);
  const linesStr = String(Number.isFinite(lines) ? Math.max(1, Math.min(10_000, Math.floor(lines))) : 100);
  const quotedDir = shQuote(`/opt/apps/${deployment.name}`);

  // For failed deployments, return the build error from statusDetail
  // since docker compose logs will be empty if the container never started
  if (deployment.status === "failed") {
    const detail = deployment.statusDetail ?? "Unknown failure";
    try {
      const dockerLogs = await sshExec(
        infra.hostingNodeIp,
        `cd ${quotedDir} && docker compose logs --tail ${linesStr} 2>&1`,
      );
      if (dockerLogs.trim()) return `[Build Error]\n${detail}\n\n[Docker Logs]\n${dockerLogs}`;
    } catch {
      // docker compose logs failed — app dir may not exist
    }
    return `[Build Error]\n${detail}`;
  }

  return sshExec(
    infra.hostingNodeIp,
    `cd ${quotedDir} && docker compose logs --tail ${linesStr} 2>&1`,
  );
}

export async function restartDeployment(
  deployId: string,
  userId: string,
  isAdmin = false,
): Promise<void> {
  const rows = db
    .select()
    .from(schema.deployments)
    .where(eq(schema.deployments.id, deployId))
    .all();

  const deployment = rows[0];
  if (!deployment || (!isAdmin && deployment.userId !== userId)) {
    throw new Error("Deployment not found");
  }

  const infraRows = db
    .select()
    .from(schema.infrastructureConfigs)
    .where(eq(schema.infrastructureConfigs.id, deployment.infraId))
    .all();

  const infra = infraRows[0];
  if (!infra?.hostingNodeIp) throw new Error("Hosting node not available");

  assertSafeName(deployment.name);
  await sshExec(
    infra.hostingNodeIp,
    `cd ${shQuote(`/opt/apps/${deployment.name}`)} && docker compose restart`,
  );

  db.update(schema.deployments)
    .set({ status: "running", statusDetail: null, updatedAt: new Date() })
    .where(eq(schema.deployments.id, deployId))
    .run();
}

export async function destroyDeployment(
  deployId: string,
  userId: string,
  isAdmin = false,
): Promise<void> {
  const rows = db
    .select()
    .from(schema.deployments)
    .where(eq(schema.deployments.id, deployId))
    .all();

  const deployment = rows[0];
  if (!deployment || (!isAdmin && deployment.userId !== userId)) {
    throw new Error("Deployment not found");
  }

  const infraRows = db
    .select()
    .from(schema.infrastructureConfigs)
    .where(eq(schema.infrastructureConfigs.id, deployment.infraId))
    .all();

  const infra = infraRows[0];
  if (infra?.hostingNodeIp) {
    // Stop and remove containers + volumes
    try {
      assertSafeName(deployment.name);
      const quotedDir = shQuote(`/opt/apps/${deployment.name}`);
      await sshExec(
        infra.hostingNodeIp,
        `cd ${quotedDir} && docker compose down -v 2>/dev/null; rm -rf ${quotedDir}`,
      );
    } catch {
      // Best effort cleanup
    }

    // Remove DNS record via Cloudflare config
    if (deployment.domain) {
      const cfConfigs = db
        .select()
        .from(schema.infrastructureConfigs)
        .where(
          and(
            eq(schema.infrastructureConfigs.userId, userId),
            eq(schema.infrastructureConfigs.provider, "cloudflare"),
          ),
        )
        .all();

      const cfConfig = cfConfigs[0];
      if (cfConfig) {
        try {
          const cf = JSON.parse(cfConfig.config) as { apiToken: string; zoneId: string };
          await deleteCloudflareDns(cf.apiToken, cf.zoneId, deployment.domain);
        } catch {
          // Best effort
        }
      }
    }
  }

  db.update(schema.deployments)
    .set({ status: "destroyed", statusDetail: null, updatedAt: new Date() })
    .where(eq(schema.deployments.id, deployId))
    .run();
}

function updateDeployment(
  id: string,
  updates: Partial<{ statusDetail: string }>,
): void {
  db.update(schema.deployments)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(schema.deployments.id, id))
    .run();
}
