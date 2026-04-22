import { randomPassword } from "./secrets.js";

/**
 * First-run bootstrap for the bundled Infisical.
 *
 * Performs: admin signup → org create (implicit via signup) → default project
 * create → machine identity with universal-auth → client credentials.
 *
 * Idempotent: if the admin already exists (e.g., re-running install), the
 * signup call returns 400 and we surface a clear "already bootstrapped"
 * message. The caller can then skip and trust the existing INFISICAL_*
 * values in .env.
 *
 * Infisical's REST surface is deep; the endpoints below were extracted from
 * @infisical/sdk 3.0.4's index.js. Shapes are best-effort for Infisical
 * server v0.100+ — if the instance is older, calls will surface 400/404 and
 * the error message points at the failing URL.
 */

export interface BootstrapInput {
  /** Base URL reachable from the installer host, e.g. http://localhost:8080 */
  baseUrl: string;
  /** Admin email to register (won't be deliverable — label only). */
  adminEmail: string;
  /** Organization name to create. Cosmetic. */
  orgName: string;
  /** Default project name where secrets will live. */
  projectName: string;
}

export interface BootstrapResult {
  adminEmail: string;
  adminPassword: string;
  projectId: string;
  clientId: string;
  clientSecret: string;
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
  throw new Error(`Infisical did not become ready within ${String(timeoutMs)}ms (last error: ${String(lastErr)})`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function request<T>(
  url: string,
  init: RequestInit,
): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`${init.method ?? "GET"} ${url} failed (${String(r.status)}): ${body.slice(0, 500)}`);
  }
  return (await r.json()) as T;
}

export async function bootstrapInfisical(
  input: BootstrapInput,
  log: (line: string) => void,
): Promise<BootstrapResult> {
  log(`[infisical] waiting for ${input.baseUrl}/api/status…`);
  await waitForHealthy(input.baseUrl);
  log("[infisical] instance is up");

  const adminPassword = randomPassword(28);

  // 1. Admin signup. Returns { token, user, organization } on success.
  log("[infisical] creating admin + organization…");
  let adminResp: {
    token?: string;
    accessToken?: string;
    user?: { id: string; email: string };
    organization?: { id: string; name: string };
  };
  try {
    adminResp = await request(`${input.baseUrl}/api/v1/admin/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: input.adminEmail,
        password: adminPassword,
        firstName: "Agent",
        lastName: "Hub",
        organizationName: input.orgName,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    if (/already/i.test(msg) || /exists/i.test(msg) || /400/.test(msg)) {
      throw new Error(
        `Infisical is already bootstrapped. If INFISICAL_CLIENT_ID is empty in .env but Infisical has an admin, log into https://secrets.<domain>/ manually, create a machine identity, and paste the creds into .env.\n\nUnderlying error: ${msg}`,
      );
    }
    throw err;
  }

  const jwt = adminResp.token ?? adminResp.accessToken;
  if (!jwt) throw new Error("admin signup returned no token field — unexpected Infisical response shape");
  const authHeaders = { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" };

  const orgId = adminResp.organization?.id;
  if (!orgId) throw new Error("admin signup returned no organization.id");
  log(`[infisical] org ${orgId}`);

  // 2. Create default project (workspace).
  log(`[infisical] creating project "${input.projectName}"…`);
  const projectResp = await request<{
    project?: { id: string; name: string };
    workspace?: { id: string; name: string };
  }>(`${input.baseUrl}/api/v2/workspace`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      projectName: input.projectName,
      slug: input.projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      organizationId: orgId,
    }),
  });
  const projectId = projectResp.project?.id ?? projectResp.workspace?.id;
  if (!projectId) throw new Error("project creation returned no id");
  log(`[infisical] project ${projectId}`);

  // 3. Create machine identity at org level.
  log("[infisical] creating machine identity…");
  const identityResp = await request<{
    identity?: { id: string; name: string };
  }>(`${input.baseUrl}/api/v1/identities`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      name: "agenthub-server",
      organizationId: orgId,
      role: "admin",
    }),
  });
  const identityId = identityResp.identity?.id;
  if (!identityId) throw new Error("identity creation returned no id");
  log(`[infisical] identity ${identityId}`);

  // 4. Attach universal-auth to the identity.
  log("[infisical] attaching universal-auth…");
  await request(`${input.baseUrl}/api/v1/auth/universal-auth/identities/${identityId}`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      clientSecretTrustedIps: [{ ipAddress: "0.0.0.0/0" }],
      accessTokenTrustedIps: [{ ipAddress: "0.0.0.0/0" }],
      accessTokenTTL: 2592000,
      accessTokenMaxTTL: 2592000,
      accessTokenNumUsesLimit: 0,
    }),
  });

  // 5. Generate a client secret for the identity.
  log("[infisical] generating client secret…");
  const csResp = await request<{
    clientSecret?: string;
    clientSecretData?: { clientSecret?: string };
  }>(`${input.baseUrl}/api/v1/auth/universal-auth/identities/${identityId}/client-secrets`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      description: "agenthub-server universal-auth",
      numUsesLimit: 0,
      ttl: 0,
    }),
  });
  const clientSecret = csResp.clientSecret ?? csResp.clientSecretData?.clientSecret;
  if (!clientSecret) throw new Error("client-secrets endpoint returned no secret");

  // 6. Fetch the identity's clientId (attribute of the universal-auth config).
  const uaResp = await request<{
    identityUniversalAuth?: { clientId: string };
  }>(`${input.baseUrl}/api/v1/auth/universal-auth/identities/${identityId}`, {
    method: "GET",
    headers: authHeaders,
  });
  const clientId = uaResp.identityUniversalAuth?.clientId;
  if (!clientId) throw new Error("universal-auth fetch returned no clientId");

  // 7. Add the identity to the project so it can write secrets there.
  log("[infisical] attaching identity to project…");
  await request(`${input.baseUrl}/api/v2/workspace/${projectId}/identity-memberships/${identityId}`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      role: "admin",
    }),
  });

  log("[infisical] bootstrap complete");
  return {
    adminEmail: input.adminEmail,
    adminPassword,
    projectId,
    clientId,
    clientSecret,
  };
}
