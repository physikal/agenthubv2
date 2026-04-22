import { spawn } from "node:child_process";
import { randomPassword } from "./secrets.js";

/**
 * First-run bootstrap for the bundled Infisical.
 *
 * Uses the official `infisical bootstrap` CLI via `npx @infisical/cli` so
 * we don't need to reimplement Infisical's client-side SRP key derivation.
 * The CLI creates: admin user + organization + instance-admin machine
 * identity with a pre-configured universal-auth client ID + secret.
 *
 * Output we care about (from the CLI's --output json mode):
 *   { identity: { id, name, credentials: { clientId, clientSecret } },
 *     organization: { id, name, slug },
 *     user: { id, email, firstName, lastName } }
 *
 * Idempotent via `--ignore-if-bootstrapped`: re-running an install against
 * an already-initialized Infisical is a no-op + the CLI exits 0 with an
 * empty-ish response. In that case we emit a helpful warning and leave
 * existing INFISICAL_CLIENT_ID/SECRET in .env alone.
 *
 * Remaining gap: the bootstrap identity is organization-scoped; it needs
 * to be attached to a project before the AgentHub server can write secrets.
 * We still need to create a project + attach the identity, but those two
 * REST calls are simple (just need a valid bearer) and don't need crypto.
 */

const INFISICAL_CLI_VERSION = "latest";

export interface BootstrapInput {
  baseUrl: string;
  adminEmail: string;
  orgName: string;
  projectName: string;
}

export interface BootstrapResult {
  adminEmail: string;
  adminPassword: string;
  projectId: string;
  clientId: string;
  clientSecret: string;
}

interface CliBootstrapOutput {
  identity?: {
    id?: string;
    name?: string;
    credentials?: {
      // Empirically: `infisical bootstrap --output json` returns a single
      // long-lived bearer token here — not a clientId/clientSecret pair.
      // We use it as a bearer for subsequent API calls, then attach
      // universal-auth ourselves and generate proper client creds.
      token?: string;
    };
  };
  organization?: {
    id?: string;
    name?: string;
    slug?: string;
  };
  user?: {
    id?: string;
    email?: string;
  };
}

async function waitForHealthy(baseUrl: string, timeoutMs = 180_000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/api/status`);
      if (r.ok) return;
      lastErr = `status=${String(r.status)}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await sleep(3_000);
  }
  throw new Error(
    `Infisical did not become ready within ${String(timeoutMs)}ms (last: ${String(lastErr)})`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run `npx -y @infisical/cli@<ver> bootstrap ...` and parse its JSON output. */
async function runInfisicalBootstrap(
  baseUrl: string,
  email: string,
  password: string,
  orgName: string,
  log: (line: string) => void,
): Promise<CliBootstrapOutput> {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      `@infisical/cli@${INFISICAL_CLI_VERSION}`,
      "bootstrap",
      "--domain", baseUrl,
      "--email", email,
      "--password", password,
      "--organization", orgName,
      "--output", "json",
      "--ignore-if-bootstrapped",
    ];
    log(`[infisical] invoking: npx ${args.slice(0, 3).join(" ")} bootstrap …`);
    const proc = spawn("npx", args, {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      // Surface progress lines so the install doesn't look hung while npx
      // downloads the CLI (~20 MB).
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) log(`[npx] ${line.trim()}`);
      }
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(
          `infisical bootstrap exited ${String(code)}\nstdout: ${stdout.slice(-1000)}\nstderr: ${stderr.slice(-1000)}`,
        ));
        return;
      }
      // The CLI prints JSON on stdout; strip anything before the first "{".
      const start = stdout.indexOf("{");
      if (start === -1) {
        reject(new Error(`infisical bootstrap returned no JSON: ${stdout.slice(0, 500)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.slice(start)) as CliBootstrapOutput);
      } catch (err) {
        reject(new Error(
          `infisical bootstrap JSON parse failed: ${(err as Error).message}\nraw: ${stdout.slice(0, 500)}`,
        ));
      }
    });
  });
}

async function authFetch<T>(
  url: string,
  bearer: string,
  init: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  const r = await fetch(url, { ...init, headers });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`${init.method ?? "GET"} ${url} → ${String(r.status)}: ${body.slice(0, 400)}`);
  }
  return (await r.json()) as T;
}

/**
 * Attach universal-auth to the bootstrap identity + generate a client secret.
 * Returns { clientId, clientSecret } the server can use to authenticate.
 */
async function attachUniversalAuth(
  baseUrl: string,
  bearer: string,
  identityId: string,
): Promise<{ clientId: string; clientSecret: string }> {
  // 1. Attach universal-auth method. TTL 0 = no expiry; use limits 0 = unlimited.
  await authFetch(
    `${baseUrl}/api/v1/auth/universal-auth/identities/${identityId}`,
    bearer,
    {
      method: "POST",
      body: JSON.stringify({
        clientSecretTrustedIps: [{ ipAddress: "0.0.0.0/0" }],
        accessTokenTrustedIps: [{ ipAddress: "0.0.0.0/0" }],
        accessTokenTTL: 2592000,
        accessTokenMaxTTL: 2592000,
        accessTokenNumUsesLimit: 0,
      }),
    },
  );

  // 2. Generate a client secret.
  const csResp = await authFetch<{
    clientSecret?: string;
    clientSecretData?: { clientSecret?: string };
  }>(
    `${baseUrl}/api/v1/auth/universal-auth/identities/${identityId}/client-secrets`,
    bearer,
    {
      method: "POST",
      body: JSON.stringify({
        description: "agenthub-server universal-auth",
        numUsesLimit: 0,
        ttl: 0,
      }),
    },
  );
  const clientSecret = csResp.clientSecret ?? csResp.clientSecretData?.clientSecret;
  if (!clientSecret) throw new Error("client-secrets returned no secret");

  // 3. Read the clientId from the universal-auth config.
  const uaResp = await authFetch<{
    identityUniversalAuth?: { clientId: string };
  }>(
    `${baseUrl}/api/v1/auth/universal-auth/identities/${identityId}`,
    bearer,
    { method: "GET" },
  );
  const clientId = uaResp.identityUniversalAuth?.clientId;
  if (!clientId) throw new Error("universal-auth GET returned no clientId");

  return { clientId, clientSecret };
}

/**
 * Log in as the admin user and return an org-scoped access token.
 *
 * Infisical's auth is a two-step flow: /api/v3/auth/login exchanges email +
 * password for a generic access token (no org context), then
 * /api/v3/auth/select-organization binds that token to an org so subsequent
 * workspace/project operations have the context they need.
 *
 * Using the admin user's token (rather than the machine identity's bearer)
 * for project creation is important: Infisical auto-adds the project
 * creator as a member. If the identity creates the project, only the
 * identity is a member — the admin user logs into the UI and sees nothing.
 */
async function loginAdminUser(
  baseUrl: string,
  email: string,
  password: string,
  orgId: string,
): Promise<string> {
  const login = await authFetch<{ accessToken: string }>(
    `${baseUrl}/api/v3/auth/login`,
    "",
    {
      method: "POST",
      body: JSON.stringify({ email, password }),
      headers: {},
    },
  );
  const selected = await authFetch<{ token: string }>(
    `${baseUrl}/api/v3/auth/select-organization`,
    login.accessToken,
    {
      method: "POST",
      body: JSON.stringify({ organizationId: orgId }),
    },
  );
  return selected.token;
}

/**
 * Create the project as the admin user (so they become a member), then
 * attach the machine identity so the AgentHub server can authenticate.
 */
async function createProjectAndAttach(
  baseUrl: string,
  userBearer: string,
  orgId: string,
  identityId: string,
  projectName: string,
): Promise<string> {
  const proj = await authFetch<{
    project?: { id: string };
    workspace?: { id: string };
  }>(`${baseUrl}/api/v2/workspace`, userBearer, {
    method: "POST",
    body: JSON.stringify({
      projectName,
      slug: projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      organizationId: orgId,
    }),
  });
  const projectId = proj.project?.id ?? proj.workspace?.id;
  if (!projectId) throw new Error("workspace create returned no id");

  // Admin user is auto-added because they created the project. Now attach
  // the machine identity so the AgentHub server can authenticate.
  try {
    await authFetch(
      `${baseUrl}/api/v2/workspace/${projectId}/identity-memberships/${identityId}`,
      userBearer,
      {
        method: "POST",
        body: JSON.stringify({ role: "admin" }),
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (!/already exists/i.test(msg)) throw err;
  }

  return projectId;
}

export async function bootstrapInfisical(
  input: BootstrapInput,
  log: (line: string) => void,
): Promise<BootstrapResult> {
  log(`[infisical] waiting for ${input.baseUrl}/api/status…`);
  await waitForHealthy(input.baseUrl);
  log("[infisical] instance is up");

  const adminPassword = randomPassword(24);

  log("[infisical] running `infisical bootstrap` (may download CLI on first run)…");
  const out = await runInfisicalBootstrap(
    input.baseUrl,
    input.adminEmail,
    adminPassword,
    input.orgName,
    log,
  );

  const bearer = out.identity?.credentials?.token;
  const orgId = out.organization?.id;
  const identityId = out.identity?.id;

  if (!bearer) {
    throw new Error(
      "Infisical bootstrap succeeded but returned no identity.credentials.token. " +
        "The CLI output shape may have changed — check the raw JSON and open an issue.",
    );
  }
  if (!orgId || !identityId) {
    throw new Error(
      "Infisical bootstrap response missing organization.id or identity.id — unexpected shape",
    );
  }

  log(`[infisical] bootstrap done: org ${orgId}, identity ${identityId}`);

  // The bootstrap identity only carries a raw JWT. AgentHub's secret store
  // (InfisicalStore) uses universal-auth login, which needs a clientId +
  // clientSecret pair. Attach universal-auth to the bootstrap identity and
  // generate those creds.
  log("[infisical] attaching universal-auth + generating client secret…");
  const { clientId, clientSecret } = await attachUniversalAuth(
    input.baseUrl,
    bearer,
    identityId,
  );

  // Log in as the admin USER (not the identity) so the admin is auto-added
  // as a project member. Otherwise they log into the Infisical UI and see
  // an empty project list, while AgentHub-written secrets are invisible.
  log("[infisical] logging in as admin user to scope project creation…");
  const userBearer = await loginAdminUser(
    input.baseUrl,
    input.adminEmail,
    adminPassword,
    orgId,
  );

  log(`[infisical] creating project "${input.projectName}" + attaching identity…`);
  const projectId = await createProjectAndAttach(
    input.baseUrl,
    userBearer,
    orgId,
    identityId,
    input.projectName,
  );

  log(`[infisical] project ${projectId} ready`);
  return {
    adminEmail: input.adminEmail,
    adminPassword,
    projectId,
    clientId,
    clientSecret,
  };
}
